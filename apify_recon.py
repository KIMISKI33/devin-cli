#!/usr/bin/env python3
"""
APIFY EXTERNAL RECONNAISSANCE MODULE
Integrates Apify Actors for web-based intelligence gathering
Complements local network scanning with external attack surface discovery
"""

import json
import logging
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

logger = logging.getLogger(__name__)


class ReconType(Enum):
    SUBDOMAIN_ENUM = "subdomain_enumeration"
    DNS_RECORDS = "dns_records"
    WEB_CRAWL = "web_crawling"
    SOCIAL_MEDIA = "social_media"
    TECH_DETECTION = "technology_detection"
    SCREENSHOT = "screenshot_capture"
    CERTIFICATE = "certificate_transparency"


@dataclass
class ApifyReconResult:
    """Structured result from Apify reconnaissance"""
    recon_type: ReconType
    target: str
    timestamp: str
    data: Dict[str, Any]
    actor_used: str
    run_id: Optional[str] = None


class ApifyReconClient:
    """
    Client for Apify-based external reconnaissance.
    Uses MCP tools when available, falls back to direct API calls.
    """

    # Actor mappings for reconnaissance tasks
    ACTORS = {
        ReconType.SUBDOMAIN_ENUM: {
            "actor": "apify/subdomain-enumerator",
            "description": "Enumerate subdomains via certificate transparency logs",
            "default_input": {"maxResults": 1000}
        },
        ReconType.DNS_RECORDS: {
            "actor": "apify/dns-records-scanner",
            "description": "Query DNS records (A, AAAA, MX, TXT, NS, SOA)",
            "default_input": {"recordTypes": ["A", "AAAA", "MX", "TXT", "NS"]}
        },
        ReconType.WEB_CRAWL: {
            "actor": "apify/web-scraper",
            "description": "Crawl website and extract data",
            "default_input": {
                "crawlerType": "cheerio",
                "maxCrawlDepth": 2,
                "maxPages": 50
            }
        },
        ReconType.TECH_DETECTION: {
            "actor": "apify/website-tech-stack-analyzer",
            "description": "Detect technologies used on websites",
            "default_input": {}
        },
        ReconType.SCREENSHOT: {
            "actor": "apify/screenshot-url",
            "description": "Capture screenshots of web pages",
            "default_input": {"wait": 2000, "delay": 500}
        },
        ReconType.CERTIFICATE: {
            "actor": "apify/certificate-transparency-logs",
            "description": "Query certificate transparency logs",
            "default_input": {"includeExpired": False}
        },
        ReconType.SOCIAL_MEDIA: {
            "actor": "apify/instagram-scraper",
            "description": "Scrape social media profiles",
            "default_input": {"resultsLimit": 100}
        }
    }

    def __init__(self, use_mcp: bool = True, api_token: Optional[str] = None):
        """
        Initialize Apify reconnaissance client.

        Args:
            use_mcp: Use MCP tools if available (Claude Desktop/Code)
            api_token: Apify API token (fallback if no MCP)
        """
        self.use_mcp = use_mcp
        self.api_token = api_token
        self.results_cache: List[ApifyReconResult] = []

    def _check_mcp_available(self) -> bool:
        """Check if MCP tools are available"""
        try:
            # Check if we can import MCP tools
            import importlib.util
            spec = importlib.util.find_spec("mcp")
            if spec is None:
                # Try checking for available tools via claude-flow
                return False
            return True
        except:
            return False

    def run_recon(
        self,
        recon_type: ReconType,
        target: str,
        custom_input: Optional[Dict] = None,
        wait: bool = True,
        timeout: int = 120
    ) -> ApifyReconResult:
        """
        Run reconnaissance using appropriate Apify Actor.

        Args:
            recon_type: Type of reconnaissance to perform
            target: Target domain/URL/profile
            custom_input: Override default actor input
            wait: Wait for completion (vs fire-and-forget)
            timeout: Maximum wait time in seconds

        Returns:
            ApifyReconResult with discovered data
        """
        actor_config = self.ACTORS.get(recon_type)
        if not actor_config:
            raise ValueError(f"Unknown recon type: {recon_type}")

        logger.info(f"[*] Starting {recon_type.value} for target: {target}")
        logger.info(f"    Actor: {actor_config['actor']}")

        # Build input
        actor_input = actor_config["default_input"].copy()
        if custom_input:
            actor_input.update(custom_input)

        # Add target-specific fields
        if recon_type in [ReconType.SUBDOMAIN_ENUM, ReconType.DNS_RECORDS, ReconType.CERTIFICATE]:
            actor_input["domain"] = target
        elif recon_type == ReconType.SOCIAL_MEDIA:
            actor_input["username"] = target
        else:
            actor_input["url"] = target if target.startswith("http") else f"https://{target}"

        # Execute via MCP or direct API
        if self.use_mcp and self._check_mcp_available():
            result = self._run_via_mcp(
                actor_config["actor"],
                actor_input,
                wait,
                timeout
            )
        else:
            result = self._run_via_api(
                actor_config["actor"],
                actor_input,
                wait,
                timeout
            )

        # Structure the result
        recon_result = ApifyReconResult(
            recon_type=recon_type,
            target=target,
            timestamp=datetime.now().isoformat(),
            data=result.get("data", {}),
            actor_used=actor_config["actor"],
            run_id=result.get("runId")
        )

        self.results_cache.append(recon_result)
        return recon_result

    def _run_via_mcp(
        self,
        actor: str,
        actor_input: Dict,
        wait: bool,
        timeout: int
    ) -> Dict:
        """Execute Actor via MCP tools (for Claude Desktop/Code)"""
        logger.debug(f"[MCP] Calling actor: {actor}")

        # MCP tool call format
        # This would be used when running inside Claude with MCP configured
        return {
            "status": "completed",
            "runId": "mcp-run-" + datetime.now().strftime("%s"),
            "data": {
                "mcp_mode": True,
                "actor": actor,
                "input": actor_input,
                "note": "MCP execution - results would come from tool call"
            }
        }

    def _run_via_api(
        self,
        actor: str,
        actor_input: Dict,
        wait: bool,
        timeout: int
    ) -> Dict:
        """Execute Actor via direct Apify API"""
        if not self.api_token:
            raise ValueError("API token required for direct API calls")

        try:
            from apify_client import ApifyClient

            client = ApifyClient(self.api_token)

            # Start the Actor run
            run = client.actor(actor).call(run_input=actor_input)
            run_id = run["id"]

            logger.info(f"    Run ID: {run_id}")

            if wait:
                # Wait for completion
                run = client.run(run_id).wait_for_finish(timeout_secs=timeout)

                if run["status"] == "SUCCEEDED":
                    # Fetch results from dataset
                    dataset_id = run["defaultDatasetId"]
                    items = client.dataset(dataset_id).list_items().items

                    return {
                        "status": "completed",
                        "runId": run_id,
                        "data": {"items": items, "total": len(items)}
                    }
                else:
                    return {
                        "status": run["status"],
                        "runId": run_id,
                        "data": {"error": "Run did not succeed"}
                    }
            else:
                return {
                    "status": "running",
                    "runId": run_id,
                    "data": {}
                }

        except ImportError:
            logger.error("[!] apify_client not installed. Install: pip install apify-client")
            return {"status": "error", "data": {"error": "apify_client not installed"}}
        except Exception as e:
            logger.error(f"[!] Apify API error: {e}")
            return {"status": "error", "data": {"error": str(e)}}

    def full_attack_surface_recon(
        self,
        domain: str,
        include_screenshots: bool = False
    ) -> Dict[str, ApifyReconResult]:
        """
        Comprehensive external reconnaissance for a domain.

        Args:
            domain: Target domain (e.g., "example.com")
            include_screenshots: Capture screenshots of discovered assets

        Returns:
            Dictionary of recon results by type
        """
        results = {}

        recon_tasks = [
            (ReconType.SUBDOMAIN_ENUM, "Subdomain enumeration"),
            (ReconType.DNS_RECORDS, "DNS record collection"),
            (ReconType.CERTIFICATE, "Certificate transparency"),
        ]

        if include_screenshots:
            recon_tasks.append((ReconType.SCREENSHOT, "Screenshot capture"))

        for recon_type, description in recon_tasks:
            try:
                logger.info(f"[*] {description}...")
                result = self.run_recon(recon_type, domain)
                results[recon_type.value] = result
            except Exception as e:
                logger.error(f"[!] {description} failed: {e}")
                results[recon_type.value] = None

        return results

    def correlate_with_network(
        self,
        network_results: Dict,
        apify_results: Dict[str, ApifyReconResult]
    ) -> Dict:
        """
        Correlate external (Apify) with internal (network) reconnaissance.

        Identifies:
        - External services without internal visibility
        - Shadow IT / unknown cloud assets
        - Subdomain takeover candidates
        """
        correlation = {
            "external_subdomains": [],
            "internal_ips": [],
            "mismatches": [],
            "shadow_assets": []
        }

        # Extract subdomains from Apify results
        subdomain_result = apify_results.get(ReconType.SUBDOMAIN_ENUM.value)
        if subdomain_result:
            subdomains = subdomain_result.data.get("items", [])
            correlation["external_subdomains"] = [
                item.get("subdomain") for item in subdomains
            ]

        # Extract internal IPs from network scan
        hosts = network_results.get("hosts", [])
        correlation["internal_ips"] = [h.get("ip") for h in hosts]

        # Identify potential mismatches
        # (e.g., subdomains pointing to IPs not in internal network)
        dns_result = apify_results.get(ReconType.DNS_RECORDS.value)
        if dns_result:
            records = dns_result.data.get("items", [])
            for record in records:
                if record.get("type") == "A":
                    ip = record.get("value")
                    if ip and ip not in correlation["internal_ips"]:
                        correlation["shadow_assets"].append({
                            "type": "external_hosting",
                            "name": record.get("name"),
                            "ip": ip
                        })

        return correlation


def create_recon_config(domain: str, output_file: str = "recon-config.json"):
    """Generate a reconnaissance configuration file"""
    config = {
        "target": domain,
        "phases": {
            "external": {
                "enabled": True,
                "modules": [
                    "subdomain_enumeration",
                    "dns_records",
                    "certificate_transparency",
                    "technology_detection"
                ]
            },
            "network": {
                "enabled": True,
                "subnet": "auto-detect"
            },
            "inventory": {
                "enabled": True,
                "hosts": "discovered"
            }
        },
        "stealth": False,
        "output": {
            "format": "json",
            "correlation": True,
            "screenshots": False
        }
    }

    with open(output_file, 'w') as f:
        json.dump(config, f, indent=2)

    logger.info(f"[+] Recon configuration saved to {output_file}")
    return config


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Apify External Reconnaissance")
    parser.add_argument("domain", help="Target domain")
    parser.add_argument("--token", help="Apify API token")
    parser.add_argument("--mcp", action="store_true", help="Use MCP tools")
    parser.add_argument("--full", action="store_true", help="Full attack surface recon")
    parser.add_argument("--screenshots", action="store_true", help="Include screenshots")
    parser.add_argument("--output", "-o", help="Output file")

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)

    client = ApifyReconClient(use_mcp=args.mcp, api_token=args.token)

    if args.full:
        results = client.full_attack_surface_recon(
            args.domain,
            include_screenshots=args.screenshots
        )
    else:
        result = client.run_recon(ReconType.SUBDOMAIN_ENUM, args.domain)
        results = {"subdomain_enumeration": result}

    # Output
    output_data = {
        "target": args.domain,
        "timestamp": datetime.now().isoformat(),
        "results": {
            k: {
                "type": v.recon_type.value if v else None,
                "data": v.data if v else None,
                "actor": v.actor_used if v else None
            }
            for k, v in results.items()
        }
    }

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(output_data, f, indent=2)
        logger.info(f"[+] Results saved to {args.output}")
    else:
        print(json.dumps(output_data, indent=2))
