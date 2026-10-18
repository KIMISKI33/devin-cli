#!/usr/bin/env python3
"""
UNIFIED RECONNAISSANCE COORDINATOR
Combines network topology mapping + host inventory scanning
One command for complete network + endpoint visibility
"""

import json
import subprocess
import os
import sys
import tempfile
import argparse
import logging
from datetime import datetime
from typing import Dict, List, Optional
from dataclasses import asdict
from pathlib import Path

# Import our modules
from network_mapper_secure import SecureNetworkMapper, Host
from syn_scanner import SynStealthScanner, TcpConnectFallback, auto_scan

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class UnifiedRecon:
    """
    Coordinates network scanning with per-host deep inventory
    """

    def __init__(
        self,
        stealth: bool = False,
        use_syn: bool = True,
        max_workers: int = 50,
        output_dir: str = None
    ):
        self.stealth = stealth
        self.use_syn = use_syn
        self.max_workers = max_workers
        self.output_dir = output_dir or os.getcwd()

        # Initialize scanners
        self.network_mapper = SecureNetworkMapper(
            max_workers=max_workers,
            stealth=stealth
        )

        self.recon_results = {
            "scan_metadata": {
                "timestamp": datetime.now().isoformat(),
                "stealth_mode": stealth,
                "syn_scan": use_syn,
                "scanner_version": "2.0"
            },
            "network_topology": {},
            "host_inventories": []
        }

    def run_network_discovery(
        self,
        subnet: str = None,
        known_hosts: List[Dict] = None,
        scan_services: bool = True
    ) -> Dict:
        """
        Phase 1: Discover network topology
        """
        logger.info("="*50)
        logger.info("PHASE 1: NETWORK DISCOVERY")
        logger.info("="*50)

        results = self.network_mapper.run_discovery(
            subnet=subnet,
            known_hosts=known_hosts,
            scan_services=scan_services
        )

        self.recon_results["network_topology"] = results
        return results

    def scan_with_syn(
        self,
        hosts: List[str],
        ports: List[int] = None
    ) -> Dict[str, List[Dict]]:
        """
        Phase 1.5: SYN stealth scan on discovered hosts
        """
        if not self.use_syn:
            return {}

        logger.info("="*50)
        logger.info("PHASE 1.5: SYN STEALTH SCAN")
        logger.info("="*50)

        ports = ports or [22, 80, 443, 3306, 5432, 6379, 8080, 8443, 9000]
        syn_results = {}

        # Check if we have raw socket permissions
        try:
            import socket
            test = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP)
            test.close()
            has_raw = True
        except PermissionError:
            logger.warning("[!] No raw socket permissions, SYN scan unavailable")
            has_raw = False

        if not has_raw:
            return {}

        scanner = SynStealthScanner()

        for host in hosts:
            logger.info(f"[*] SYN scanning {host}...")
            results = scanner.scan_host(host, ports, rate_limit=0.05 if self.stealth else 0.01)

            open_ports = [r for r in results if r.status.name == "OPEN"]
            if open_ports:
                syn_results[host] = [
                    {
                        "port": r.port,
                        "status": r.status.name,
                        "latency_ms": r.response_time_ms,
                        "ttl": r.ttl,
                        "window_size": r.window_size
                    }
                    for r in open_ports
                ]

        self.recon_results["syn_scan_results"] = syn_results
        return syn_results

    def run_host_inventory(
        self,
        target_host: str,
        ssh_user: str = None,
        ssh_key: str = None,
        use_local: bool = False
    ) -> Optional[Dict]:
        """
        Phase 2: Deep inventory scan on target host
        Uses SSH to run linux-inventory-scanner.sh remotely
        """
        logger.info(f"[*] Running inventory on {target_host}...")

        if use_local or target_host in ["127.0.0.1", "localhost"]:
            return self._run_local_inventory()
        else:
            return self._run_remote_inventory(target_host, ssh_user, ssh_key)

    def _run_local_inventory(self) -> Optional[Dict]:
        """Run inventory scanner locally"""
        try:
            script_path = Path(__file__).parent / "linux-inventory-scanner.sh"

            if not script_path.exists():
                logger.error(f"[!] Inventory script not found: {script_path}")
                return None

            # Run with --stealth if requested
            cmd = ["bash", str(script_path)]
            if self.stealth:
                cmd.append("--stealth")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60
            )

            if result.returncode == 0:
                # Parse JSON output
                lines = result.stdout.strip().split('\n')
                # Find JSON in output
                json_str = ''
                in_json = False
                for line in lines:
                    if line.startswith('{'):
                        in_json = True
                    if in_json:
                        json_str += line
                    if line.rstrip().endswith('}'):
                        break

                return json.loads(json_str) if json_str else None
            else:
                logger.error(f"[!] Inventory failed: {result.stderr}")
                return None

        except Exception as e:
            logger.error(f"[!] Local inventory error: {e}")
            return None

    def _run_remote_inventory(
        self,
        target: str,
        user: str,
        key: str
    ) -> Optional[Dict]:
        """Run inventory via SSH using host keys provisioned in known-hosts files.

        Unknown or changed host keys are rejected; verify keys out of band first.
        """
        try:
            # Copy script to remote
            script_path = Path(__file__).parent / "linux-inventory-scanner.sh"

            if not script_path.exists():
                logger.error(f"[!] Inventory script not found: {script_path}")
                return None

            # Create remote temp path
            remote_path = f"/tmp/linux-inventory-{datetime.now().strftime('%s')}.sh"

            ssh_options = ["-o", "StrictHostKeyChecking=yes"]
            if key:
                ssh_options.extend(["-i", key])

            # SCP script to target
            scp_cmd = ["scp", *ssh_options]
            scp_cmd.extend([str(script_path), f"{user}@{target}:{remote_path}"])

            result = subprocess.run(scp_cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                logger.error(f"[!] SCP failed: {result.stderr.decode()}")
                return None

            # Execute remotely
            ssh_cmd = ["ssh", *ssh_options]
            ssh_cmd.extend([f"{user}@{target}", f"bash {remote_path}"])

            if self.stealth:
                ssh_cmd[-1] += " --stealth"

            result = subprocess.run(
                ssh_cmd,
                capture_output=True,
                text=True,
                timeout=120
            )

            # Cleanup remote script
            subprocess.run([
                "ssh", *ssh_options,
                f"{user}@{target}", f"rm {remote_path}"
            ], capture_output=True)

            if result.returncode == 0:
                # Parse JSON from output
                lines = result.stdout.strip().split('\n')
                json_str = ''
                in_json = False
                for line in lines:
                    if line.startswith('{'):
                        in_json = True
                    if in_json:
                        json_str += line
                    if line.rstrip().endswith('}'):
                        break

                return json.loads(json_str) if json_str else None
            else:
                logger.error(f"[!] Remote inventory failed: {result.stderr}")
                return None

        except Exception as e:
            logger.error(f"[!] Remote inventory error: {e}")
            return None

    def correlate_results(self):
        """
        Phase 3: Correlate network + inventory data
        """
        logger.info("="*50)
        logger.info("PHASE 3: CORRELATION")
        logger.info("="*50)

        topology = self.recon_results.get("network_topology", {})
        hosts = topology.get("hosts", [])
        services = topology.get("services", [])
        inventories = self.recon_results.get("host_inventories", [])

        # Build service index by IP
        services_by_ip = {}
        for svc in services:
            ip = svc.get("ip")
            if ip not in services_by_ip:
                services_by_ip[ip] = []
            services_by_ip[ip].append(svc)

        # Correlate
        correlated = []
        for host in hosts:
            ip = host.get("ip")
            entry = {
                "ip": ip,
                "hostname": host.get("hostname"),
                "latency_ms": host.get("latency_ms"),
                "services": services_by_ip.get(ip, []),
                "inventory": None
            }

            # Find matching inventory
            for inv in inventories:
                if inv.get("hostname") == entry["hostname"] or \
                   any(ip == iface.get("ip") for iface in inv.get("interfaces", [])):
                    entry["inventory"] = inv
                    break

            correlated.append(entry)

        self.recon_results["correlated_hosts"] = correlated
        return correlated

    def export_recon_report(self, filename: str = None) -> str:
        """Export unified reconnaissance report"""
        if not filename:
            timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
            filename = f"unified-recon-{timestamp}.json"

        filepath = os.path.join(self.output_dir, filename)

        with open(filepath, 'w') as f:
            json.dump(self.recon_results, f, indent=2)

        logger.info(f"[+] Report saved: {filepath}")
        return filepath

    def print_summary(self):
        """Print reconnaissance summary"""
        topology = self.recon_results.get("network_topology", {})
        inventories = self.recon_results.get("host_inventories", [])

        print("\n" + "="*60)
        print("UNIFIED RECONNAISSANCE SUMMARY")
        print("="*60)
        print(f"Stealth Mode: {self.stealth}")
        print(f"Hosts Discovered: {len(topology.get('hosts', []))}")
        print(f"Services Found: {len(topology.get('services', []))}")
        print(f"Host Inventories: {len(inventories)}")
        print()

        # Network topology
        print("NETWORK TOPOLOGY:")
        for host in topology.get('hosts', []):
            latency = host.get('latency_ms', '?')
            latency_str = f"{latency:.1f}ms" if isinstance(latency, (int, float)) else str(latency)
            print(f"  {host.get('ip', 'unknown'):20} {latency_str:10} {host.get('hostname', 'unknown')}")

        # Services
        print("\nSERVICES:")
        for svc in topology.get('services', [])[:20]:  # Limit output
            print(f"  {svc.get('ip', 'unknown'):20} :{svc.get('port', '?'):<6} {svc.get('service', 'unknown')}")

        if len(topology.get('services', [])) > 20:
            print(f"  ... and {len(topology['services']) - 20} more")

        # Host details
        print("\nHOST DETAILS:")
        for inv in inventories:
            print(f"  {inv.get('hostname', 'unknown')}")
            print(f"    OS: {inv.get('os', 'unknown')}")
            print(f"    Kernel: {inv.get('kernel', 'unknown')}")
            print(f"    Tools: {len(inv.get('tools', []))} detected")
            print(f"    Processes: {len(inv.get('processes', []))} running")


def main():
    parser = argparse.ArgumentParser(
        description="Unified Network + Host Reconnaissance",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Local network scan + inventory
  sudo python unified_recon.py --subnet 192.168.1.0/24 --inventory-all

  # Stealth mode with SYN scanning
  sudo python unified_recon.py --subnet 192.168.1.0/24 --stealth --syn

  # Scan specific host via SSH
  python unified_recon.py --target 192.168.1.100 --ssh-user admin --ssh-key ~/.ssh/id_rsa

  # Known hosts + deep inventory
  python unified_recon.py --known-hosts hosts.json --inventory-all
        """
    )

    # Network options
    parser.add_argument('--subnet', help='Subnet to scan (CIDR)')
    parser.add_argument('--target', help='Single target for inventory')
    parser.add_argument('--known-hosts', help='JSON file with known hosts')

    # Scanning options
    parser.add_argument('--stealth', action='store_true', help='Stealth mode')
    parser.add_argument('--syn', action='store_true', help='Use SYN stealth scan (requires root)')
    parser.add_argument('--no-syn', action='store_true', help='Disable SYN scanning')

    # Inventory options
    parser.add_argument('--inventory-all', action='store_true', help='Inventory all discovered hosts')
    parser.add_argument('--inventory-target', action='store_true', help='Inventory only --target')
    parser.add_argument('--ssh-user', help='SSH username for remote inventory')
    parser.add_argument('--ssh-key', help='SSH private key for remote inventory')

    # Output options
    parser.add_argument('-o', '--output', help='Output file')
    parser.add_argument('--output-dir', default='.', help='Output directory')
    parser.add_argument('-v', '--verbose', action='store_true', help='Verbose output')

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Load known hosts if provided
    known_hosts = None
    if args.known_hosts:
        with open(args.known_hosts) as f:
            known_hosts = json.load(f)

    # Initialize recon
    recon = UnifiedRecon(
        stealth=args.stealth,
        use_syn=args.syn and not args.no_syn,
        output_dir=args.output_dir
    )

    try:
        # Phase 1: Network discovery
        if args.subnet or known_hosts:
            recon.run_network_discovery(
                subnet=args.subnet,
                known_hosts=known_hosts
            )

        # Phase 1.5: SYN scan
        if args.syn and not args.no_syn:
            topology = recon.recon_results.get("network_topology", {})
            hosts = [h.get("ip") for h in topology.get("hosts", []) if h.get("ip")]
            if hosts:
                recon.scan_with_syn(hosts[:10])  # Limit to first 10 in stealth

        # Phase 2: Host inventory
        if args.inventory_target and args.target:
            is_local = args.target in ["127.0.0.1", "localhost"]
            inv = recon.run_host_inventory(
                args.target,
                args.ssh_user,
                args.ssh_key,
                use_local=is_local
            )
            if inv:
                recon.recon_results["host_inventories"].append(inv)

        elif args.inventory_all:
            topology = recon.recon_results.get("network_topology", {})
            for host in topology.get("hosts", [])[:5]:  # Limit for safety
                ip = host.get("ip")
                if ip:
                    is_local = ip in ["127.0.0.1", "::1", "localhost"]
                    inv = recon.run_host_inventory(
                        ip,
                        args.ssh_user,
                        args.ssh_key,
                        use_local=is_local
                    )
                    if inv:
                        recon.recon_results["host_inventories"].append(inv)

        # Phase 3: Correlate
        if recon.recon_results["host_inventories"]:
            recon.correlate_results()

        # Output
        recon.print_summary()

        if not args.stealth:
            report_path = recon.export_recon_report(args.output)
            print(f"\n[+] Full report: {report_path}")
        else:
            print("\n[*] Stealth mode: report not saved to disk")

    except KeyboardInterrupt:
        print("\n[!] Interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"[!] Recon failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
