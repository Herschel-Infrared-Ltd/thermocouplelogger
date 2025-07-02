import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import client from "prom-client";
import { channelData, config, channelMap } from "./index";
import { logger } from "./logger";

/** Hono web application instance */
const app = new Hono();

// Static file serving
app.use("/*", serveStatic({ root: "./public" }));

// Root route to serve index.html
app.get("/", (c) => {
  return c.redirect("/index.html");
});

// Prometheus metrics setup

/** Prometheus metrics registry for collecting and exposing metrics */
const register = new client.Registry();

/** Prometheus gauge metric for thermocouple channel temperatures */
const channelTemperatureGauge = new client.Gauge({
  name: "thermocouple_channel_temperature",
  help: "Temperature reading for each thermocouple channel",
  labelNames: ["channel", "type", "name", "connected"],
});

/** Prometheus gauge metric for thermocouple channel connection status */
const channelConnectedGauge = new client.Gauge({
  name: "thermocouple_channel_connected",
  help: "Connection status for each channel (1=connected, 0=not connected)",
  labelNames: ["channel", "type", "name"],
});

/** Prometheus gauge metric for thermocouple configuration information */
const thermocoupleInfoGauge = new client.Gauge({
  name: "thermocouple_info",
  help: "Thermocouple configuration info (labels only, value always 1)",
  labelNames: ["name", "type", "channel"],
});

/** Prometheus gauge metric for seconds since last update for each channel */
const channelLastUpdateGauge = new client.Gauge({
  name: "thermocouple_channel_last_update_seconds",
  help: "Seconds since last update for each channel",
  labelNames: ["channel", "type", "name"],
});

register.registerMetric(channelTemperatureGauge);
register.registerMetric(channelConnectedGauge);
register.registerMetric(thermocoupleInfoGauge);
register.registerMetric(channelLastUpdateGauge);

/**
 * Get the decimal channel number from a hex channel key
 * @param channelHex - Hex channel identifier (e.g., "41", "42")
 * @returns The corresponding decimal channel number (1-12) or 0 if not found
 */
function getChannelNumber(channelHex: string): number {
  return channelMap[channelHex] || 0;
}

/**
 * Check if a channel has recent data (within the last 60 seconds)
 * @param lastUpdate - Date of the last data update for the channel
 * @returns True if the channel is considered connected (has recent data)
 */
function isChannelConnected(lastUpdate: Date): boolean {
  const now = new Date();
  const timeDiff = (now.getTime() - lastUpdate.getTime()) / 1000;
  return timeDiff < 60 && lastUpdate.getTime() > 0;
}

// API Routes

/**
 * GET /api/readings - Get current readings for all active thermocouple channels
 * Returns an array of thermocouple readings including both configured and auto-detected channels
 */
app.get("/api/readings", async (c) => {
  logger.log("[GET] /api/readings");
  try {
    const readings = [];

    // Go through all active channels (both configured and auto-detected)
    for (const [channelHex, data] of Object.entries(channelData)) {
      const channelNum = getChannelNumber(channelHex);
      const connected = isChannelConnected(data.lastUpdate);
      const age = (Date.now() - data.lastUpdate.getTime()) / 1000;

      readings.push({
        id: channelNum,
        name: data.config.name,
        type: data.config.type,
        temperature: connected ? data.temperature : null,
        connected: connected,
        lastUpdate: data.lastUpdate.toISOString(),
        ageSeconds: age,
        // New detection metadata
        detected: data.detected,
        firstSeen: data.firstSeen.toISOString(),
        dataCount: data.dataCount,
        channel: channelNum,
      });
    }

    // Sort by channel number for consistent ordering
    readings.sort((a, b) => a.channel - b.channel);

    return c.json({
      readings,
      totalActive: readings.length,
      totalConfigured: config.thermocouples.length,
      totalDetected: readings.filter(r => r.detected).length,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.log("[GET] /api/readings - Response: 500", err.message);
    c.status(500);
    return c.json({ error: err.message || "Unknown error" });
  }
});

/**
 * GET /api/readings/:name - Get current reading for a specific thermocouple by name
 * Returns temperature data for the specified thermocouple or error if not found/connected
 * @param name - The name of the thermocouple as configured in config.json
 */
app.get("/api/readings/:name", async (c) => {
  const { name } = c.req.param();
  logger.log(`[GET] /api/readings/${name}`);

  // Find thermocouple by name
  const tc = config.thermocouples.find((t) => t.name === name);
  if (!tc) {
    c.status(404);
    return c.json({ error: `Unknown thermocouple: ${name}` });
  }

  // Find the corresponding hex key for this channel
  const channelHex = Object.keys(channelMap).find(
    (key) => channelMap[key] === tc.channel
  );

  if (!channelHex || !channelData[channelHex]) {
    c.status(404);
    return c.json({ error: `No data available for ${name}` });
  }

  const data = channelData[channelHex];
  const connected = isChannelConnected(data.lastUpdate);

  if (!connected) {
    c.status(503);
    return c.json({ error: `No recent data for ${name}` });
  }

  return c.json({
    [name]: data.temperature,
    temperature: data.temperature,
    type: tc.type,
    channel: tc.channel,
    lastUpdate: data.lastUpdate.toISOString(),
  });
});

/**
 * GET /metrics - Prometheus metrics endpoint
 * Exposes thermocouple data in Prometheus format for monitoring and alerting
 * Includes temperature, connection status, configuration info, and data age metrics
 */
app.get("/metrics", async (c) => {
  logger.log("[GET] /metrics");
  try {
    // Reset all metrics
    channelTemperatureGauge.reset();
    channelConnectedGauge.reset();
    thermocoupleInfoGauge.reset();
    channelLastUpdateGauge.reset();

    // Set thermocouple info metrics (configuration)
    for (const tc of config.thermocouples) {
      thermocoupleInfoGauge.set(
        {
          name: tc.name,
          type: tc.type,
          channel: tc.channel.toString(),
        },
        1
      );
    }

    // Set channel metrics based on current data
    for (const tc of config.thermocouples) {
      const channelHex = Object.keys(channelMap).find(
        (key) => channelMap[key] === tc.channel
      );

      if (channelHex && channelData[channelHex]) {
        const data = channelData[channelHex];
        const connected = isChannelConnected(data.lastUpdate);
        const age = (Date.now() - data.lastUpdate.getTime()) / 1000;

        const labels = {
          channel: tc.channel.toString(),
          type: tc.type,
          name: tc.name,
        };

        // Only set temperature if connected
        if (connected) {
          channelTemperatureGauge.set(
            { ...labels, connected: "1" },
            data.temperature
          );
        }

        // Set connection status
        channelConnectedGauge.set(labels, connected ? 1 : 0);

        // Set age since last update
        if (data.lastUpdate.getTime() > 0) {
          channelLastUpdateGauge.set(labels, age);
        }
      } else {
        // Channel configured but no data
        const labels = {
          channel: tc.channel.toString(),
          type: tc.type,
          name: tc.name,
        };

        channelConnectedGauge.set(labels, 0);
      }
    }

    const metrics = await register.metrics();
    c.header("Content-Type", "text/plain; version=0.0.4");
    return c.text(metrics);
  } catch (err: any) {
    logger.log("[GET] /metrics - Error:", err.message);
    c.status(500);
    return c.text(`# Error: ${err.message || "Unknown error"}`);
  }
});

/**
 * GET /health - Health check endpoint
 * Returns system status including configured vs connected thermocouple counts
 */
app.get("/health", async (c) => {
  const connectedCount = config.thermocouples.filter((tc) => {
    const channelHex = Object.keys(channelMap).find(
      (key) => channelMap[key] === tc.channel
    );
    return (
      channelHex &&
      channelData[channelHex] &&
      isChannelConnected(channelData[channelHex].lastUpdate)
    );
  }).length;

  return c.json({
    status: "ok",
    configuredThermocouples: config.thermocouples.length,
    connectedThermocouples: connectedCount,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/config - Get current thermocouple configuration
 * Returns the loaded configuration showing all configured thermocouple channels
 */
app.get("/api/config", async (c) => {
  return c.json({
    thermocouples: config.thermocouples,
    timestamp: new Date().toISOString(),
  });
});

/** Server configuration and export */
const port = 3000;

logger.log("Thermocouple web server will listen on port 3000");

serve({
  fetch: app.fetch,
  port,
});

logger.log(`Server is running on http://localhost:${port}`);
