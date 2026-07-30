#!/usr/bin/env python3
"""
HYBRID RECONNAISSANCE SYSTEM
Combines local network scanning with external Apify-based intelligence
Provides complete attack surface visibility (internal + external)
"""

import json
import logging
import argparse
import asyncio
from datetime import datetime
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from pathlib import Path

# Import our modules
from unified_recon import UnifiedRecon
from apify_recon import ApifyReconClient, ReconType, create_recon_config
from network_mapper_secure import SecureNetworkMapper

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class HybridReconReport:
    """Complete hybrid reconnaissance report"""
    timestamp: str
    target_domain: Optional[str]
    local_subnet: Optional[str]
    external_recon: Dict[str, Any]
    internal_recon: Dict[str, Any]
    correlation: Dict[str, Any]
    findings: List[Dict[str, Any]]
    recommendations: List[str]


class HybridReconSystem:
    """
    Unified internal + external reconnaissance coordinator.

    Phase 1: External reconnaissance (Apify)
    - Subdomain enumeration
    - DNS record collection
    - Certificate transparency
    - Technology detection

    Phase 2: Internal reconnaissance (local)
    - Network discovery
    - Port scanning
    - Host inventory

    Phase 3: Correlation
    - Match external assets to internal IPs
    - Identify shadow IT/unknown cloud services
    - Detect subdomain takeover candidates
    """

    def __init__(
        self,
        apify_token: Optional[str] = None,
        use_mcp: bool = True,
        stealth: bool = False,
        output_dir: str = "."
    ):
        self.apify_token = apify_token
        self.use_mcp = use_mcp
        self.stealth = stealth
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Initialize components
        self.external_client = ApifyReconClient(
            use_mcp=use_mcp,
            api_token=apify_token
        )
        self.internal_recon = UnifiedRecon(
            stealth=stealth,
            use_syn=False,  # Windows limitation
            output_dir=str(output_dir)
        )

        self.report_data: Dict[str, Any] = {}

    def run_full_recon(
        self,
        domain: Optional[str] = None,
        subnet: Optional[str] = None,
        config_file: Optional[str] = None
    ) -> HybridReconReport:
        """
        Execute full hybrid reconnaissance.

        Args:
            domain: Target domain for external recon
            subnet: Local subnet for internal recon
            config_file: JSON config file with recon parameters

        Returns:
            HybridReconReport with all findings
        """
        logger.info("=" * 70)
        logger.info("HYBRID RECONNAISSANCE SYSTEM")
        logger.info("Internal Network + External Attack Surface")
        logger.info("=" * 70)

        # Load config if provided
        config = self._load_config(config_file) if config_file else {}

        domain = domain or config.get("target")
        subnet = subnet or config.get("phases", {}).get("network", {}).get("subnet")

        external_results = {}
        internal_results = {}

        # Phase 1: External Reconnaissance
        if domain and (not config or config.get("phases", {}).get("external", {}).get("enabled", True)):
            logger.info("\n" + "=" * 70)
            logger.info("PHASE 1: EXTERNAL RECONNAISSANCE (Apify)")
            logger.info("=" * 70)
            external_results = self._run_external_recon(domain, config)

        # Phase 2: Internal Reconnaissance
        if subnet and (not config or config.get("phases", {}).get("network", {}).get("enabled", True)):
            logger.info("\n" + "=" * 70)
            logger.info("PHASE 2: INTERNAL RECONNAISSANCE (Local Network)")
            logger.info("=" * 70)
            internal_results = self._run_internal_recon(subnet, config)

        # Phase 3: Correlation
        logger.info("\n" + "=" * 70)
        logger.info("PHASE 3: CORRELATION & ANALYSIS")
        logger.info("=" * 70)
        correlation = self._correlate_findings(external_results, internal_results)

        # Phase 4: Generate Findings
        findings = self._generate_findings(external_results, internal_results, correlation)
        recommendations = self._generate_recommendations(findings)

        # Create report
        report = HybridReconReport(
            timestamp=datetime.now().isoformat(),
            target_domain=domain,
            local_subnet=subnet,
            external_recon=external_results,
            internal_recon=internal_results,
            correlation=correlation,
            findings=findings,
            recommendations=recommendations
        )

        return report

    def _load_config(self, config_file: str) -> Dict:
        """Load reconnaissance configuration"""
        with open(config_file) as f:
            return json.load(f)

    def _run_external_recon(self, domain: str, config: Dict) -> Dict[str, Any]:
        """Execute external reconnaissance via Apify"""
        results = {}

        modules = config.get("phases", {}).get("external", {}).get("modules", [
            "subdomain_enumeration",
            "dns_records",
            "certificate_transparency"
        ])

        module_map = {
            "subdomain_enumeration": ReconType.SUBDOMAIN_ENUM,
            "dns_records": ReconType.DNS_RECORDS,
            "certificate_transparency": ReconType.CERTIFICATE,
            "technology_detection": ReconType.TECH_DETECTION,
            "screenshots": ReconType.SCREENSHOT
        }

        for module in modules:
            recon_type = module_map.get(module)
            if not recon_type:
                logger.warning(f"[!] Unknown module: {module}")
                continue

            try:
                result = self.external_client.run_recon(recon_type, domain)
                results[module] = {
                    "type": result.recon_type.value,
                    "target": result.target,
                    "actor": result.actor_used,
                    "data": result.data,
                    "timestamp": result.timestamp
                }
            except Exception as e:
                logger.error(f"[!] External recon failed for {module}: {e}")
                results[module] = {"error": str(e)}

        return results

    def _run_internal_recon(self, subnet: str, config: Dict) -> Dict[str, Any]:
        """Execute internal reconnaissance via local scanning"""
        try:
            network_results = self.internal_recon.run_network_discovery(
                subnet=subnet,
                known_hosts=None,
                scan_services=True
            )

            # Optionally run inventory on discovered hosts
            inventory_enabled = config.get("phases", {}).get("inventory", {}).get("enabled", False)
            if inventory_enabled:
                topology = self.internal_recon.recon_results.get("network_topology", {})
                hosts = topology.get("hosts", [])
                for host in hosts[:5]:  # Limit for safety
                    ip = host.get("ip")
                    if ip:
                        self.internal_recon.run_host_inventory(ip, use_local=(ip == "127.0.0.1"))

            return self.internal_recon.recon_results

        except Exception as e:
            logger.error(f"[!] Internal recon failed: {e}")
            return {"error": str(e)}

    def _correlate_findings(
        self,
        external: Dict[str, Any],
        internal: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Correlate external and internal findings"""
        correlation = {
            "external_assets": [],
            "internal_assets": [],
            "matched_assets": [],
            "shadow_it": [],
            "subdomain_takeover_candidates": [],
            "technology_stack": {}
        }

        # Extract external subdomains
        subdomain_data = external.get("subdomain_enumeration", {}).get("data", {})
        subdomains = subdomain_data.get("items", [])
        correlation["external_assets"] = [
            {"type": "subdomain", "name": s.get("subdomain")}
            for s in subdomains
        ]

        # Extract internal IPs
        topology = internal.get("network_topology", {})
        hosts = topology.get("hosts", [])
        correlation["internal_assets"] = [
            {"type": "host", "ip": h.get("ip"), "hostname": h.get("hostname")}
            for h in hosts
        ]

        # Extract DNS records for matching
        dns_data = external.get("dns_records", {}).get("data", {})
        dns_items = dns_data.get("items", [])

        internal_ips = {h.get("ip") for h in hosts if h.get("ip")}

        for record in dns_items:
            if record.get("type") == "A":
                ip = record.get("value")
                name = record.get("name")

                if ip in internal_ips:
                    correlation["matched_assets"].append({
                        "type": "dns_match",
                        "name": name,
                        "ip": ip,
                        "source": "external_dns"
                    })
                else:
                    correlation["shadow_it"].append({
                        "type": "external_hosting",
                        "name": name,
                        "ip": ip,
                        "risk": "unknown_cloud_provider"
                    })

        # Technology detection
        tech_data = external.get("technology_detection", {}).get("data", {})
        correlation["technology_stack"] = tech_data.get("items", [])

        logger.info(f"[*] Correlation complete:")
        logger.info(f"    External assets: {len(correlation['external_assets'])}")
        logger.info(f"    Internal assets: {len(correlation['internal_assets'])}")
        logger.info(f"    Matched: {len(correlation['matched_assets'])}")
        logger.info(f"    Shadow IT: {len(correlation['shadow_it'])}")

        return correlation

    def _generate_findings(
        self,
        external: Dict[str, Any],
        internal: Dict[str, Any],
        correlation: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Generate security findings from reconnaissance data"""
        findings = []

        # Finding 1: Exposed Services
        topology = internal.get("network_topology", {})
        services = topology.get("services", [])
        for svc in services:
            if svc.get("port") in [22, 3389, 5900]:  # Remote access
                findings.append({
                    "severity": "MEDIUM",
                    "type": "exposed_service",
                    "title": f"Remote access service exposed: {svc.get('service')}",
                    "description": f"{svc.get('service')} on {svc.get('ip')}:{svc.get('port')}",
                    "recommendation": "Restrict access with firewall rules"
                })

        # Finding 2: Shadow IT
        shadow = correlation.get("shadow_it", [])
        for asset in shadow:
            findings.append({
                "severity": "HIGH",
                "type": "shadow_it",
                "title": f"Unknown cloud asset: {asset.get('name')}",
                "description": f"Resolves to {asset.get('ip')} (not in internal network)",
                "recommendation": "Audit cloud infrastructure and update asset inventory"
            })

        # Finding 3: Subdomain Enumeration Results
        subdomains = external.get("subdomain_enumeration", {}).get("data", {}).get("items", [])
        if len(subdomains) > 50:
            findings.append({
                "severity": "INFO",
                "type": "attack_surface",
                "title": "Large subdomain attack surface",
                "description": f"{len(subdomains)} subdomains discovered",
                "recommendation": "Review subdomains for unnecessary exposure"
            })

        # Finding 4: Outdated Technology
        tech_stack = correlation.get("technology_stack", [])
        for tech in tech_stack:
            if any(old in str(tech).lower() for old in ['windows xp', 'iis 6', 'apache 2.2']):
                findings.append({
                    "severity": "HIGH",
                    "type": "outdated_technology",
                    "title": "Outdated technology detected",
                    "description": str(tech),
                    "recommendation": "Upgrade to supported versions"
                })

        return findings

    def _generate_recommendations(self, findings: List[Dict]) -> List[str]:
        """Generate actionable recommendations"""
        recommendations = []

        # Group by severity
        critical = [f for f in findings if f.get("severity") == "CRITICAL"]
        high = [f for f in findings if f.get("severity") == "HIGH"]
        medium = [f for f in findings if f.get("severity") == "MEDIUM"]

        if critical:
            recommendations.append(f"Address {len(critical)} CRITICAL findings immediately")
        if high:
            recommendations.append(f"Remediate {len(high)} HIGH severity issues within 7 days")
        if medium:
            recommendations.append(f"Review {len(medium)} MEDIUM severity issues within 30 days")

        # Generic recommendations
        recommendations.extend([
            "Implement continuous external attack surface monitoring",
            "Deploy asset discovery agent on all internal networks",
            "Review and update firewall rules based on discovered services",
            "Establish cloud asset tagging policy to prevent shadow IT"
        ])

        return recommendations

    def export_report(
        self,
        report: HybridReconReport,
        format: str = "json",
        filename: Optional[str] = None
    ) -> str:
        """Export reconnaissance report"""
        if not filename:
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            filename = f"hybrid-recon-{timestamp}.{format}"

        filepath = self.output_dir / filename

        if format == "json":
            with open(filepath, 'w') as f:
                json.dump(asdict(report), f, indent=2)
        elif format == "html":
            self._export_html(report, filepath)

        logger.info(f"[+] Report exported: {filepath}")
        return str(filepath)

    def _export_html(self, report: HybridReconReport, filepath: Path):
        """Generate HTML report"""
        html = f"""<!DOCTYPE html>
<html>
<head>
    <title>Hybrid Reconnaissance Report - {report.target_domain or 'Network'}</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 40px; background: #1a1a2e; color: #eee; }}
        h1, h2 {{ color: #4ecca3; }}
        .finding {{ background: #16213e; padding: 10px; margin: 10px 0; border-left: 4px solid #e74c3c; }}
        .finding.HIGH {{ border-color: #e74c3c; }}
        .finding.MEDIUM {{ border-color: #f39c12; }}
        .finding.INFO {{ border-color: #3498db; }}
        table {{ border-collapse: collapse; width: 100%; margin: 20px 0; }}
        th, td {{ border: 1px solid #0f3460; padding: 12px; text-align: left; }}
        th {{ background: #0f3460; }}
        tr:nth-child(even) {{ background: #16213e; }}
    </style>
</head>
<body>
    <h1>Hybrid Reconnaissance Report</h1>
    <p><strong>Target:</strong> {report.target_domain or 'N/A'}</p>
    <p><strong>Subnet:</strong> {report.local_subnet or 'N/A'}</p>
    <p><strong>Timestamp:</strong> {report.timestamp}</p>

    <h2>Executive Summary</h2>
    <p>Discovered {len(report.findings)} security findings across internal and external attack surfaces.</p>

    <h2>Findings</h2>
    {''.join(f'<div class="finding {f.get("severity", "INFO")}"><strong>[{f.get("severity")}] {f.get("title")}</strong><br/>{f.get("description")}<br/><em>Recommendation: {f.get("recommendation")}</em></div>' for f in report.findings)}

    <h2>Recommendations</h2>
    <ul>
        {''.join(f'<li>{r}</li>' for r in report.recommendations)}
    </ul>
</body>
</html>"""

        with open(filepath, 'w') as f:
            f.write(html)

    def print_summary(self, report: HybridReconReport):
        """Print report summary to console"""
        print("\n" + "=" * 70)
        print("HYBRID RECONNAISSANCE SUMMARY")
        print("=" * 70)
        print(f"Target Domain: {report.target_domain or 'N/A'}")
        print(f"Local Subnet: {report.local_subnet or 'N/A'}")
        print(f"Timestamp: {report.timestamp}")
        print()

        print("FINDINGS:")
        for finding in report.findings:
            severity = finding.get("severity", "INFO")
            title = finding.get("title", "Unknown")
            print(f"  [{severity:8}] {title}")

        print()
        print("RECOMMENDATIONS:")
        for i, rec in enumerate(report.recommendations[:5], 1):
            print(f"  {i}. {rec}")


def main():
    parser = argparse.ArgumentParser(
        description="Hybrid Reconnaissance (Internal + External)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full hybrid recon
  python hybrid_recon.py --domain example.com --subnet 192.168.1.0/24

  # External only
  python hybrid_recon.py --domain example.com --token YOUR_APIFY_TOKEN

  # Internal only
  python hybrid_recon.py --subnet 192.168.1.0/24

  # With config file
  python hybrid_recon.py --config recon-config.json

  # Generate config template
  python hybrid_recon.py --generate-config example.com
        """
    )

    parser.add_argument("--domain", help="Target domain for external recon")
    parser.add_argument("--subnet", help="Local subnet for internal recon")
    parser.add_argument("--token", help="Apify API token")
    parser.add_argument("--config", help="Configuration JSON file")
    parser.add_argument("--mcp", action="store_true", help="Use MCP tools")
    parser.add_argument("--stealth", action="store_true", help="Stealth mode")
    parser.add_argument("--output-dir", default=".", help="Output directory")
    parser.add_argument("--format", choices=["json", "html"], default="json", help="Output format")
    parser.add_argument("--generate-config", metavar="DOMAIN", help="Generate config template")

    args = parser.parse_args()

    if args.generate_config:
        create_recon_config(args.generate_config)
        return

    # Validate arguments
    if not args.domain and not args.subnet and not args.config:
        parser.error("Must specify --domain, --subnet, or --config")

    # Initialize system
    system = HybridReconSystem(
        apify_token=args.token,
        use_mcp=args.mcp,
        stealth=args.stealth,
        output_dir=args.output_dir
    )

    try:
        # Run reconnaissance
        report = system.run_full_recon(
            domain=args.domain,
            subnet=args.subnet,
            config_file=args.config
        )

        # Output results
        system.print_summary(report)

        # Export report
        output_file = system.export_report(report, format=args.format)
        print(f"\n[+] Full report saved: {output_file}")

    except KeyboardInterrupt:
        print("\n[!] Interrupted by user")
    except Exception as e:
        logger.error(f"[!] Reconnaissance failed: {e}")
        raise


if __name__ == "__main__":
    main()
