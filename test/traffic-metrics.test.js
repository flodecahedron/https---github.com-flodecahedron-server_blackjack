import test from "node:test";
import assert from "node:assert/strict";
import { TrafficMetrics } from "../src/traffic-metrics.js";

test("traffic metrics aggregates byte counts by message type", () => {
  const metrics = new TrafficMetrics({ intervalSeconds: 0, logger: () => {} });
  metrics.recordInbound("bet", "12345");
  metrics.recordInbound("bet", "12");
  metrics.recordOutbound("room_delta", "abcd");
  const report = metrics.snapshot();
  assert.deepEqual(report.inboundByType.bet, { messages: 2, bytes: 7 });
  assert.deepEqual(report.outboundByType.room_delta, { messages: 1, bytes: 4 });
});
