import { BlockList, isIP } from "node:net";
import { bypassesProxy, proxyBypassList } from "../shared/network-proxy";

/** Host rules retain NO_PROXY semantics; CIDRs use Node's IPv4/IPv6 parser. */
export class NetworkBypass {
  private readonly hosts: string[];
  private readonly subnets = new BlockList();
  readonly hasSubnets: boolean;

  constructor(bypass = "") {
    this.hosts = proxyBypassList(bypass);
    for (const entry of this.hosts) {
      const match = /^(.+)\/(\d{1,3})$/.exec(entry);
      if (!match) continue;
      const address = match[1].replace(/^\[|\]$/g, "");
      const family = isIP(address);
      const prefix = Number(match[2]);
      if (!family || prefix > (family === 4 ? 32 : 128)) continue;
      this.subnets.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
    }
    this.hasSubnets = this.subnets.rules.length > 0;
  }

  matchesSubnet(address: string) {
    const host = address.replace(/^\[|\]$/g, "");
    const family = isIP(host);
    return !!family && this.subnets.check(host, family === 4 ? "ipv4" : "ipv6");
  }

  matches(hostname: string) {
    return bypassesProxy(hostname, this.hosts) || this.matchesSubnet(hostname);
  }
}
