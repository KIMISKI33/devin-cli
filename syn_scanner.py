#!/usr/bin/env python3
"""
SYN STEALTH SCANNER
Raw socket implementation for TCP SYN port scanning
Requires root privileges on Linux/macOS
Windows requires WinPcap/Npcap and Scapy
"""

import socket
import struct
import random
import time
import logging
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class ScanResult(Enum):
    OPEN = "open"
    CLOSED = "closed"
    FILTERED = "filtered"
    TIMEOUT = "timeout"


@dataclass
class SynScanResult:
    ip: str
    port: int
    status: ScanResult
    response_time_ms: float
    ttl: Optional[int] = None
    window_size: Optional[int] = None


class SynStealthScanner:
    """
    TCP SYN (half-open) scanner using raw sockets.
    Sends SYN, waits for SYN-ACK (open) or RST (closed), never completes handshake.
    """

    def __init__(self, timeout: float = 2.0, source_port: int = None):
        self.timeout = timeout
        self.source_port = source_port or random.randint(1024, 65535)
        self.source_ip = self._get_source_ip()

    def _get_source_ip(self) -> str:
        """Get primary interface IP for raw socket binding"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except:
            return "0.0.0.0"

    def _checksum(self, data: bytes) -> int:
        """Calculate IP/TCP checksum"""
        if len(data) % 2:
            data += b'\x00'

        s = sum(struct.unpack('!%dH' % (len(data) // 2), data))
        s = (s >> 16) + (s & 0xffff)
        s += s >> 16
        return ~s & 0xffff

    def _create_tcp_syn_packet(
        self,
        src_ip: str,
        dst_ip: str,
        src_port: int,
        dst_port: int,
        seq_num: int = None
    ) -> Tuple[bytes, bytes]:
        """
        Build raw TCP SYN packet with IP header
        Returns: (ip_header, tcp_header + data)
        """
        if seq_num is None:
            seq_num = random.randint(0, 2**32 - 1)

        # TCP header fields
        tcp_offset = (5 << 4)  # 5 * 4 = 20 bytes, no options
        tcp_flags = 0x02  # SYN flag only

        # TCP header (without checksum)
        tcp_header = struct.pack(
            '!HHLLBBHHH',
            src_port,      # Source port
            dst_port,      # Destination port
            seq_num,       # Sequence number
            0,             # Ack number (0 for SYN)
            tcp_offset,    # Data offset + reserved
            tcp_flags,     # Flags
            65535,         # Window size
            0,             # Checksum (placeholder)
            0              # Urgent pointer
        )

        # Pseudo-header for checksum calculation
        src_addr = socket.inet_aton(src_ip)
        dst_addr = socket.inet_aton(dst_ip)
        pseudo_header = struct.pack(
            '!4s4sBBH',
            src_addr,
            dst_addr,
            0,  # Reserved
            socket.IPPROTO_TCP,
            len(tcp_header)
        )

        # Calculate TCP checksum
        checksum = self._checksum(pseudo_header + tcp_header)
        tcp_header = tcp_header[:16] + struct.pack('!H', checksum) + tcp_header[18:]

        # IP header
        ip_version = 4
        ip_ihl = 5
        ip_tos = 0
        ip_total_length = 20 + len(tcp_header)
        ip_id = random.randint(0, 65535)
        ip_flags = 0x02  # Don't fragment
        ip_ttl = 64
        ip_protocol = socket.IPPROTO_TCP
        ip_checksum = 0

        ip_header = struct.pack(
            '!BBHHHBBH4s4s',
            (ip_version << 4) + ip_ihl,
            ip_tos,
            ip_total_length,
            ip_id,
            ip_flags,
            ip_ttl,
            ip_protocol,
            ip_checksum,
            src_addr,
            dst_addr
        )

        # Calculate IP checksum
        ip_checksum = self._checksum(ip_header)
        ip_header = ip_header[:10] + struct.pack('!H', ip_checksum) + ip_header[12:]

        return ip_header, tcp_header

    def scan_port(self, target_ip: str, port: int) -> SynScanResult:
        """
        Perform SYN scan on single port
        Requires root/admin privileges
        """
        start_time = time.time()

        try:
            # Create raw socket
            # IPPROTO_RAW allows us to build our own IP header
            sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_HDRINCL, 1)
            sock.settimeout(self.timeout)
        except PermissionError:
            logger.error("Raw sockets require root privileges")
            return SynScanResult(
                ip=target_ip,
                port=port,
                status=ScanResult.TIMEOUT,
                response_time_ms=0
            )
        except Exception as e:
            logger.error(f"Failed to create raw socket: {e}")
            return SynScanResult(
                ip=target_ip,
                port=port,
                status=ScanResult.TIMEOUT,
                response_time_ms=0
            )

        try:
            # Build SYN packet
            ip_header, tcp_packet = self._create_tcp_syn_packet(
                self.source_ip,
                target_ip,
                self.source_port,
                port
            )

            packet = ip_header + tcp_packet

            # Send packet
            sock.sendto(packet, (target_ip, 0))

            # Wait for response
            while True:
                try:
                    response, addr = sock.recvfrom(1024)
                    elapsed = (time.time() - start_time) * 1000

                    # Parse IP header
                    ip_header_len = (response[0] & 0x0f) * 4
                    ttl = response[8]

                    # Parse TCP header
                    tcp_header = response[ip_header_len:ip_header_len + 20]
                    if len(tcp_header) < 20:
                        continue

                    src_port, dst_port, seq, ack, offset_flags, window = struct.unpack(
                        '!HHLLHH',
                        tcp_header[:16]
                    )

                    flags = offset_flags & 0x3f
                    rst_flag = 0x04
                    syn_flag = 0x02
                    ack_flag = 0x10

                    # Check if response matches our scan
                    if dst_port != self.source_port:
                        continue

                    # SYN-ACK = Port open
                    if flags == (syn_flag | ack_flag):
                        return SynScanResult(
                            ip=target_ip,
                            port=port,
                            status=ScanResult.OPEN,
                            response_time_ms=elapsed,
                            ttl=ttl,
                            window_size=window
                        )

                    # RST-ACK = Port closed
                    elif flags & rst_flag:
                        return SynScanResult(
                            ip=target_ip,
                            port=port,
                            status=ScanResult.CLOSED,
                            response_time_ms=elapsed,
                            ttl=ttl
                        )

                except socket.timeout:
                    return SynScanResult(
                        ip=target_ip,
                        port=port,
                        status=ScanResult.FILTERED,
                        response_time_ms=(time.time() - start_time) * 1000
                    )

        except Exception as e:
            logger.debug(f"Scan error for {target_ip}:{port}: {e}")
            return SynScanResult(
                ip=target_ip,
                port=port,
                status=ScanResult.TIMEOUT,
                response_time_ms=(time.time() - start_time) * 1000
            )

        finally:
            sock.close()

    def scan_host(
        self,
        target_ip: str,
        ports: List[int],
        rate_limit: float = 0.01
    ) -> List[SynScanResult]:
        """
        Scan multiple ports on a host
        """
        results = []

        for port in ports:
            result = self.scan_port(target_ip, port)
            results.append(result)

            if result.status == ScanResult.OPEN:
                logger.info(f"  [+] {target_ip}:{port} OPEN (SYN) - {result.response_time_ms:.2f}ms")

            # Rate limiting
            time.sleep(rate_limit)

        return results


class TcpConnectFallback:
    """
    Fallback to TCP connect() scan when raw sockets unavailable
    (no root privileges)
    """

    def __init__(self, timeout: float = 1.0):
        self.timeout = timeout

    def scan_port(self, target_ip: str, port: int) -> SynScanResult:
        """TCP connect scan"""
        start_time = time.time()

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(self.timeout)
            result = sock.connect_ex((target_ip, port))
            elapsed = (time.time() - start_time) * 1000

            sock.close()

            if result == 0:
                return SynScanResult(
                    ip=target_ip,
                    port=port,
                    status=ScanResult.OPEN,
                    response_time_ms=elapsed
                )
            else:
                return SynScanResult(
                    ip=target_ip,
                    port=port,
                    status=ScanResult.FILTERED,
                    response_time_ms=elapsed
                )

        except Exception as e:
            return SynScanResult(
                ip=target_ip,
                port=port,
                status=ScanResult.TIMEOUT,
                response_time_ms=(time.time() - start_time) * 1000
            )


def auto_scan(
    target_ip: str,
    ports: List[int] = None,
    use_syn: bool = True
) -> List[SynScanResult]:
    """
    Auto-detect capability and scan
    Falls back to connect() if SYN unavailable
    """
    ports = ports or [80, 443, 22, 8080, 3000, 5000]

    if use_syn:
        try:
            # Test if we can create raw socket
            test_sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP)
            test_sock.close()

            logger.info(f"[*] Using SYN stealth scan (raw sockets)")
            scanner = SynStealthScanner()
            return scanner.scan_host(target_ip, ports)

        except PermissionError:
            logger.warning(f"[!] Raw sockets require root, falling back to TCP connect")

    logger.info(f"[*] Using TCP connect scan")
    scanner = TcpConnectFallback()
    results = []
    for port in ports:
        results.append(scanner.scan_port(target_ip, port))
    return results


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    if len(sys.argv) < 2:
        print("Usage: python syn_scanner.py <target_ip> [port1,port2,...]")
        sys.exit(1)

    target = sys.argv[1]
    ports = [int(p) for p in sys.argv[2].split(",")] if len(sys.argv) > 2 else None

    print(f"[*] Scanning {target}...")
    results = auto_scan(target, ports)

    print("\n=== RESULTS ===")
    open_ports = [r for r in results if r.status == ScanResult.OPEN]
    if open_ports:
        for r in open_ports:
            print(f"  OPEN: {r.ip}:{r.port} ({r.response_time_ms:.2f}ms)")
    else:
        print("  No open ports found")
