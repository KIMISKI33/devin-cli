#!/usr/bin/env python3
"""
NETWORK TOPOLOGY MAPPER - SECURE VERSION
Patched: input validation, bounded concurrency, async I/O, no shell injection
"""

import json
import subprocess
import socket
import asyncio
import ipaddress
import logging
import re
import sys
import random
import time
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# Module-level validation functions (for external use)
def validate_ip_address(ip: str) -> bool:
    """Validate IP address string. Returns True if valid, False otherwise."""
    try:
        ipaddress.ip_address(ip)
        return True
    except ValueError:
        return False


def validate_ip_network(network: str) -> bool:
    """Validate CIDR network string. Returns True if valid, False otherwise."""
    try:
        ipaddress.ip_network(network, strict=False)
        return True
    except ValueError:
        return False


@dataclass
class Host:
    """Validated host data structure"""
    ip: str
    hostname: Optional[str] = None
    latency_ms: Optional[float] = None
    os: Optional[str] = None
    source: str = "discovered"

    def __post_init__(self):
        """Validate IP address"""
        try:
            ipaddress.ip_address(self.ip)
        except ValueError:
            raise ValueError(f"Invalid IP address: {self.ip}")


@dataclass
class Service:
    """Service endpoint data"""
    ip: str
    port: int
    service: str
    status: str
    banner: Optional[str] = None

    def __post_init__(self):
        """Validate port number"""
        if not 1 <= self.port <= 65535:
            raise ValueError(f"Invalid port: {self.port}")


class SecureNetworkMapper:
    """
    Secure network topology mapper with:
    - Input validation
    - Bounded concurrency
    - Async I/O for port scanning
    - No shell injection vulnerabilities
    - Stealth options
    """

    # Common service ports (AI/ML focused)
    COMMON_PORTS = [
        22, 80, 443, 3306, 5432, 6379, 8080, 8443,
        9200, 11434, 6333, 5672, 9000, 27017, 50051,
        8888, 5000, 3000, 5900, 8000, 11435, 6334,
    ]

    SERVICE_NAMES = {
        22: "SSH", 80: "HTTP", 443: "HTTPS", 3306: "MySQL",
        5432: "PostgreSQL", 6379: "Redis", 8080: "HTTP-Alt",
        8443: "HTTPS-Alt", 9200: "Elasticsearch", 11434: "Ollama",
        6333: "Qdrant", 5672: "RabbitMQ", 9000: "Portainer",
        27017: "MongoDB", 50051: "gRPC", 8888: "Jupyter",
        5000: "Flask", 3000: "Node.js", 5900: "VNC",
        8000: "Django", 11435: "Ollama-API", 6334: "Qdrant-Alt",
    }

    def __init__(
        self,
        max_workers: int = 50,
        port_concurrency: int = 100,
        stealth: bool = False,
        jitter: Tuple[float, float] = (0.1, 0.5)
    ):
        """
        Initialize mapper with bounded concurrency.

        Args:
            max_workers: Maximum thread pool workers for host scanning
            port_concurrency: Maximum concurrent port probes
            stealth: Enable stealth mode (randomization, reduced output)
            jitter: Random delay range (min, max) seconds between probes
        """
        self.max_workers = max_workers
        self.port_concurrency = port_concurrency
        self.stealth = stealth
        self.jitter = jitter

        self.results = {
            "timestamp": datetime.now().isoformat(),
            "scan_from": socket.gethostname() if not stealth else "redacted",
            "stealth_mode": stealth,
            "hosts": [],
            "services": [],
            "scan_metadata": {
                "max_workers": max_workers,
                "port_concurrency": port_concurrency,
            }
        }

        # Thread-safe result accumulation
        self._results_lock = asyncio.Lock() if stealth else None

    def _validate_ip(self, ip: str) -> bool:
        """Validate IP address format"""
        try:
            ipaddress.ip_address(ip)
            return True
        except ValueError:
            return False

    def _validate_subnet(self, subnet: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network:
        """Validate and parse subnet"""
        try:
            # Handle CIDR notation
            if '/' not in subnet:
                # Assume /24 for IPv4
                subnet = f"{subnet}/24" if '.' in subnet else f"{subnet}/64"
            return ipaddress.ip_network(subnet, strict=False)
        except ValueError as e:
            raise ValueError(f"Invalid subnet: {subnet}") from e

    def get_local_ip(self) -> str:
        """Get local machine IP safely"""
        try:
            # Use UDP socket to determine outbound interface
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(2)
                s.connect(("8.8.8.8", 80))
                ip = s.getsockname()[0]
                if self._validate_ip(ip):
                    return ip
        except Exception as e:
            logger.debug(f"Failed to get local IP: {e}")
        return "127.0.0.1"

    def get_network_info(self) -> Optional[Dict]:
        """Detect gateway and subnet safely (no shell injection)"""
        try:
            if sys.platform == "win32":
                return self._get_network_info_windows()
            else:
                return self._get_network_info_unix()
        except Exception as e:
            logger.error(f"Failed to get network info: {e}")
            return None

    def _get_network_info_windows(self) -> Optional[Dict]:
        """Get network info on Windows using netsh (safer than parsing ipconfig)"""
        try:
            # Use netsh for structured output
            result = subprocess.run(
                ["netsh", "interface", "ipv4", "show", "config"],
                capture_output=True,
                text=True,
                timeout=10,
                shell=False  # No shell injection risk
            )

            gateway = None
            subnet = None

            for line in result.stdout.split('\n'):
                line = line.strip()
                if 'Default Gateway' in line and ':' in line:
                    parts = line.split(':')
                    if len(parts) >= 2:
                        gateway = parts[1].strip().split()[0]
                        if self._validate_ip(gateway):
                            break

            # Get local IP to infer subnet
            local_ip = self.get_local_ip()
            if local_ip and local_ip != "127.0.0.1":
                # Assume /24
                subnet = '.'.join(local_ip.split('.')[:3]) + ".0/24"

            return {"gateway": gateway, "subnet": subnet}

        except Exception as e:
            logger.debug(f"Windows network info failed: {e}")
            return None

    def _get_network_info_unix(self) -> Optional[Dict]:
        """Get network info on Linux/macOS using ip command"""
        try:
            # Get default gateway
            result = subprocess.run(
                ["ip", "route"],
                capture_output=True,
                text=True,
                timeout=5,
                shell=False
            )

            gateway = None
            iface = None

            for line in result.stdout.split('\n'):
                if 'default' in line:
                    parts = line.split()
                    if len(parts) >= 3:
                        gateway = parts[2]
                        if self._validate_ip(gateway):
                            iface = parts[-1] if len(parts) > 4 else None
                            break

            # Get subnet from interface
            subnet = None
            if iface:
                result = subprocess.run(
                    ["ip", "addr", "show", iface],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    shell=False
                )

                for line in result.stdout.split('\n'):
                    if 'inet ' in line and 'scope global' in line:
                        # Extract CIDR (e.g., 192.168.1.5/24)
                        match = re.search(r'inet\s+(\d+\.\d+\.\d+\.\d+/\d+)', line)
                        if match:
                            subnet = match.group(1)
                            break

            return {"gateway": gateway, "subnet": subnet}

        except Exception as e:
            logger.debug(f"Unix network info failed: {e}")
            return None

    def ping_host(self, ip: str, timeout: int = 2) -> Optional[float]:
        """
        Ping a host and return latency in ms.
        Uses subprocess with argument list (no shell injection).
        """
        if not self._validate_ip(ip):
            logger.warning(f"Invalid IP for ping: {ip}")
            return None

        # Prevent loopback amplification
        if ip.startswith("127."):
            return 0.1

        try:
            if sys.platform == "win32":
                cmd = [
                    "ping",
                    "-n", "1",
                    "-w", str(timeout * 1000),
                    ip
                ]
            else:
                cmd = [
                    "ping",
                    "-c", "1",
                    "-W", str(timeout),
                    ip
                ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout + 1,
                shell=False  # CRITICAL: No shell injection
            )

            if result.returncode != 0:
                return None

            # Parse latency from output
            output = result.stdout
            time_match = re.search(r'time[=:](\d+\.?\d*)\s*ms', output, re.IGNORECASE)
            if time_match:
                return float(time_match.group(1))

            return None

        except subprocess.TimeoutExpired:
            return None
        except Exception as e:
            logger.debug(f"Ping failed for {ip}: {e}")
            return None

    def scan_subnet_threadpool(
        self,
        subnet: str,
        randomize: bool = True,
        sample_size: Optional[int] = None
    ) -> List[Host]:
        """
        Scan subnet using bounded thread pool.

        Args:
            subnet: CIDR subnet (e.g., "192.168.1.0/24")
            randomize: Randomize scan order (stealth)
            sample_size: Scan only N random hosts (stealth)
        """
        network = self._validate_subnet(subnet)
        hosts = list(network.hosts())

        if randomize or self.stealth:
            random.shuffle(hosts)

        if sample_size and sample_size < len(hosts):
            hosts = hosts[:sample_size]

        logger.info(f"[*] Scanning {len(hosts)} hosts in {subnet}")

        discovered = []

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit all ping tasks
            future_to_ip = {
                executor.submit(self._probe_host_sync, str(ip)): str(ip)
                for ip in hosts
            }

            # Collect results as they complete
            for future in as_completed(future_to_ip, timeout=300):
                ip = future_to_ip[future]
                try:
                    host = future.result()
                    if host:
                        discovered.append(host)
                        logger.info(f"  [+] Found: {host.ip} ({host.latency_ms}ms)")
                except Exception as e:
                    logger.debug(f"Probe failed for {ip}: {e}")

        return discovered

    def _probe_host_sync(self, ip: str) -> Optional[Host]:
        """Synchronous host probe with jitter"""
        if self.stealth or self.jitter:
            time.sleep(random.uniform(*self.jitter))

        latency = self.ping_host(ip)
        if latency is not None:
            hostname = self._resolve_hostname(ip)
            return Host(ip=ip, latency_ms=latency, hostname=hostname)
        return None

    def _resolve_hostname(self, ip: str) -> Optional[str]:
        """Resolve IP to hostname with timeout"""
        if not self._validate_ip(ip):
            return None

        try:
            socket.setdefaulttimeout(2)
            hostname = socket.gethostbyaddr(ip)[0]
            socket.setdefaulttimeout(None)
            return hostname
        except:
            return None

    async def scan_ports_async(
        self,
        ip: str,
        ports: Optional[List[int]] = None,
        timeout: float = 1.0
    ) -> List[Service]:
        """
        Async port scan with bounded concurrency.
        Much faster than sequential scanning.
        """
        if not self._validate_ip(ip):
            logger.error(f"Invalid IP for port scan: {ip}")
            return []

        ports = ports or self.COMMON_PORTS

        if self.stealth:
            ports = ports.copy()
            random.shuffle(ports)

        semaphore = asyncio.Semaphore(self.port_concurrency)

        async def probe_port(port: int) -> Optional[Service]:
            async with semaphore:
                if self.stealth:
                    await asyncio.sleep(random.uniform(*self.jitter))

                try:
                    reader, writer = await asyncio.wait_for(
                        asyncio.open_connection(ip, port),
                        timeout=timeout
                    )

                    # Try to grab banner
                    banner = None
                    try:
                        writer.write(b'\\r\\n')
                        await asyncio.wait_for(writer.drain(), timeout=0.5)
                        banner_data = await asyncio.wait_for(reader.read(1024), timeout=0.5)
                        banner = banner_data.decode('utf-8', errors='ignore').strip()[:100]
                    except:
                        pass

                    writer.close()
                    await writer.wait_closed()

                    return Service(
                        ip=ip,
                        port=port,
                        service=self.SERVICE_NAMES.get(port, f"Port-{port}"),
                        status="OPEN",
                        banner=banner
                    )

                except asyncio.TimeoutError:
                    return None
                except OSError:
                    return None
                except Exception as e:
                    logger.debug(f"Port probe error: {e}")
                    return None

        # Run all probes concurrently
        tasks = [probe_port(port) for port in ports]
        results = await asyncio.gather(*tasks)

        return [r for r in results if r is not None]

    def scan_ports_sync(self, ip: str, ports: Optional[List[int]] = None) -> List[Service]:
        """Synchronous wrapper for async port scan"""
        return asyncio.run(self.scan_ports_async(ip, ports))

    def scan_network_services(self, hosts: List[Host]) -> List[Service]:
        """Scan services on multiple hosts"""
        all_services = []

        for host in hosts:
            logger.info(f"[*] Scanning ports on {host.ip}...")
            services = self.scan_ports_sync(host.ip)
            all_services.extend(services)

            for svc in services:
                logger.info(f"  [+] {svc.ip}:{svc.port} OPEN ({svc.service})")

        return all_services

    def run_discovery(
        self,
        subnet: Optional[str] = None,
        known_hosts: Optional[List[Dict]] = None,
        scan_services: bool = True
    ) -> Dict:
        """
        Run complete network discovery.

        Args:
            subnet: Subnet to scan (auto-detected if None)
            known_hosts: List of known host dicts to add
            scan_services: Whether to scan for open services
        """
        # Get local network info
        local_ip = self.get_local_ip()
        net_info = self.get_network_info()

        logger.info(f"[*] Local IP: {local_ip}")
        if net_info:
            logger.info(f"[*] Gateway: {net_info.get('gateway')}")
            logger.info(f"[*] Subnet: {net_info.get('subnet')}")

        # Determine subnet to scan
        scan_subnet = subnet or net_info.get("subnet") if net_info else None

        all_hosts = []

        # Add known hosts (with validation)
        if known_hosts:
            for host_data in known_hosts:
                try:
                    ip = host_data.get("ip")
                    if not self._validate_ip(ip):
                        logger.warning(f"Skipping invalid known host IP: {ip}")
                        continue

                    host = Host(
                        ip=ip,
                        hostname=host_data.get("hostname"),
                        os=host_data.get("os"),
                        source="manual"
                    )
                    # Try to get latency
                    host.latency_ms = self.ping_host(ip)
                    all_hosts.append(host)
                    logger.info(f"[*] Added known host: {host.hostname or host.ip}")
                except Exception as e:
                    logger.warning(f"Failed to add known host: {e}")

        # Scan subnet if available
        if scan_subnet:
            try:
                discovered = self.scan_subnet_threadpool(
                    scan_subnet,
                    randomize=self.stealth
                )
                all_hosts.extend(discovered)
            except Exception as e:
                logger.error(f"Subnet scan failed: {e}")

        self.results["hosts"] = [asdict(h) for h in all_hosts]

        # Scan services
        if scan_services and all_hosts:
            services = self.scan_network_services(all_hosts)
            self.results["services"] = [asdict(s) for s in services]

        return self.results

    def export_json(
        self,
        filename: Optional[str] = None,
        encrypt: bool = False
    ) -> str:
        """Export results to JSON"""
        if filename is None:
            timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
            filename = f"network-map-secure-{timestamp}.json"

        output = json.dumps(self.results, indent=2)

        if encrypt:
            # Simple XOR obfuscation (not real encryption)
            # For real security, use cryptography library
            logger.warning("Encryption requested but not implemented - saved as plain JSON")

        with open(filename, 'w') as f:
            f.write(output)

        logger.info(f"[+] Results saved to {filename}")
        return filename

    def print_summary(self):
        """Print scan summary"""
        print("\\n" + "="*50)
        print("NETWORK TOPOLOGY SUMMARY")
        print("="*50)
        print(f"Scan From: {self.results['scan_from']}")
        print(f"Stealth Mode: {self.results['stealth_mode']}")
        print(f"Active Hosts: {len(self.results['hosts'])}")
        print(f"Open Services: {len(self.results['services'])}")
        print("")

        print("HOSTS:")
        for host in self.results['hosts']:
            latency_str = f"{host.get('latency_ms', '?'):.1f}ms" if host.get('latency_ms') else "N/A"
            hostname = host.get('hostname', 'unknown') or 'unknown'
            print(f"  {host['ip']:20} {latency_str:10} {hostname}")

        print("\\nSERVICES:")
        for svc in self.results['services']:
            banner = svc.get('banner', '')
            if banner:
                banner = f" [{banner[:30]}...]" if len(banner) > 30 else f" [{banner}]"
            print(f"  {svc['ip']:20} :{svc['port']:<5} {svc['service']}{banner}")


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Secure Network Topology Mapper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                          # Normal scan
  %(prog)s --stealth                # Stealth mode (randomized, minimal output)
  %(prog)s --subnet 192.168.1.0/24  # Scan specific subnet
  %(prog)s --max-workers 20         # Limit concurrent threads
  %(prog)s --services-only          # Skip host discovery, scan known hosts only
        """
    )

    parser.add_argument(
        '--stealth', action='store_true',
        help='Enable stealth mode (randomized scanning, no file output)'
    )
    parser.add_argument(
        '--subnet', type=str,
        help='Subnet to scan (e.g., 192.168.1.0/24)'
    )
    parser.add_argument(
        '--max-workers', type=int, default=50,
        help='Maximum concurrent host probes (default: 50)'
    )
    parser.add_argument(
        '--port-concurrency', type=int, default=100,
        help='Maximum concurrent port probes (default: 100)'
    )
    parser.add_argument(
        '--output', '-o', type=str,
        help='Output file (default: auto-generated)'
    )
    parser.add_argument(
        '--services-only', action='store_true',
        help='Skip host discovery, only scan services on known hosts'
    )
    parser.add_argument(
        '--no-services', action='store_true',
        help='Skip service port scanning'
    )
    parser.add_argument(
        '--verbose', '-v', action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Initialize mapper
    mapper = SecureNetworkMapper(
        max_workers=args.max_workers,
        port_concurrency=args.port_concurrency,
        stealth=args.stealth
    )

    print("[*] SECURE NETWORK TOPOLOGY MAPPER")
    print(f"[*] Stealth Mode: {args.stealth}")

    # Define known hosts (modify as needed)
    known_hosts = [
        # Example: {"hostname": "dev-server", "ip": "192.168.1.10", "os": "Ubuntu"}
    ]

    # Run discovery
    try:
        mapper.run_discovery(
            subnet=args.subnet if not args.services_only else None,
            known_hosts=known_hosts if known_hosts else None,
            scan_services=not args.no_services
        )

        # Output
        mapper.print_summary()

        if not args.stealth:
            output_file = mapper.export_json(args.output)
            print(f"\\n[+] Full results: {output_file}")
        else:
            print("\\n[*] Stealth mode: Results not saved to disk")

    except KeyboardInterrupt:
        print("\\n[!] Scan interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Scan failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
