const byteLength = value => Buffer.byteLength(typeof value === "string" || Buffer.isBuffer(value) ? value : String(value));

export class TrafficMetrics {
  constructor({ intervalSeconds = 300, logger = console.log } = {}) {
    this.startedAt = Date.now();
    this.logger = logger;
    this.inbound = new Map();
    this.outbound = new Map();
    this.timer = intervalSeconds > 0 ? setInterval(() => this.flush(), intervalSeconds * 1000) : null;
    this.timer?.unref?.();
  }

  recordInbound(type, raw) { this.record(this.inbound, type, byteLength(raw)); }
  recordOutbound(type, raw) { this.record(this.outbound, type, byteLength(raw)); }

  record(target, type, bytes) {
    let key = String(type || "unknown").slice(0, 80);
    if (!target.has(key) && target.size >= 100) key = "other";
    const current = target.get(key) ?? { messages: 0, bytes: 0 };
    current.messages += 1;
    current.bytes += bytes;
    target.set(key, current);
  }

  snapshot() {
    const serialize = source => Object.fromEntries([...source.entries()]
      .sort((left, right) => right[1].bytes - left[1].bytes));
    const total = source => [...source.values()].reduce((sum, item) => sum + item.bytes, 0);
    return {
      periodSeconds: Math.max(1, Math.round((Date.now() - this.startedAt) / 1000)),
      inboundBytes: total(this.inbound),
      outboundBytes: total(this.outbound),
      inboundByType: serialize(this.inbound),
      outboundByType: serialize(this.outbound),
    };
  }

  flush() {
    const report = this.snapshot();
    if (report.inboundBytes || report.outboundBytes) this.logger(`[traffic] ${JSON.stringify(report)}`);
    this.startedAt = Date.now();
    this.inbound.clear();
    this.outbound.clear();
    return report;
  }
}
