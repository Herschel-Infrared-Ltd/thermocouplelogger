import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import client from "prom-client";
import { channelData, config, activeDataloggers, channelMap } from "./index";
import type { ThermocoupleConfig } from "./config";
import pc from 'picocolors';
import * as os from 'os';

/** Hono web application instance */
const app = new Hono();

/**
 * Gets all thermocouples from all active dataloggers
 * @returns Array of all thermocouple configurations with datalogger info
 */
function getAllThermocouples(): (ThermocoupleConfig & {
  dataloggerID: string;
  dataloggerName: string;
})[] {
  const allThermocouples: (ThermocoupleConfig & {
    dataloggerID: string;
    dataloggerName: string;
  })[] = [];

  for (const datalogger of activeDataloggers) {
    for (const tc of datalogger.thermocouples) {
      allThermocouples.push({
        ...tc,
        dataloggerID: datalogger.id,
        dataloggerName: datalogger.name,
      });
    }
  }

  return allThermocouples;
}

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
  labelNames: ["channel", "type", "name", "connected", "datalogger"],
});

/** Prometheus gauge metric for thermocouple channel connection status */
const channelConnectedGauge = new client.Gauge({
  name: "thermocouple_channel_connected",
  help: "Connection status for each channel (1=connected, 0=not connected)",
  labelNames: ["channel", "type", "name", "datalogger"],
});

/** Prometheus gauge metric for thermocouple configuration information */
const thermocoupleInfoGauge = new client.Gauge({
  name: "thermocouple_info",
  help: "Thermocouple configuration info (labels only, value always 1)",
  labelNames: ["name", "type", "channel", "datalogger"],
});

/** Prometheus gauge metric for seconds since last update for each channel */
const channelLastUpdateGauge = new client.Gauge({
  name: "thermocouple_channel_last_update_seconds",
  help: "Seconds since last update for each channel",
  labelNames: ["channel", "type", "name", "datalogger"],
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
  console.log(`${pc.gray("[GET]")} /api/readings`);
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

    const allThermocouples = getAllThermocouples();

    return c.json({
      readings,
      totalActive: readings.length,
      totalConfigured: allThermocouples.length,
      totalDetected: readings.filter((r) => r.detected).length,
      totalDataloggers: activeDataloggers.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.log(`${pc.gray("[GET]")} /api/readings - Response: ${pc.red("500")} ${err.message}`);
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
  console.log(`${pc.gray("[GET]")} /api/readings/${name}`);

  // Find thermocouple by name across all dataloggers
  const allThermocouples = getAllThermocouples();
  const tc = allThermocouples.find((t) => t.name === name);
  if (!tc) {
    c.status(404);
    return c.json({ error: `Unknown thermocouple: ${name}` });
  }

  // Find the corresponding hex key for this channel
  const channelHex = Object.keys(channelMap).find(
    (key) => channelMap[key] === tc.channel
  );

  // Create the channel key including datalogger ID
  const channelKey = `${tc.dataloggerID}:${channelHex}`;

  if (!channelHex || !channelData[channelKey]) {
    c.status(404);
    return c.json({ error: `No data available for ${name}` });
  }

  const data = channelData[channelKey];
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
    datalogger: tc.dataloggerName,
    lastUpdate: data.lastUpdate.toISOString(),
  });
});

/**
 * GET /metrics - Prometheus metrics endpoint
 * Exposes thermocouple data in Prometheus format for monitoring and alerting
 * Includes temperature, connection status, configuration info, and data age metrics
 */
app.get("/metrics", async (c) => {
  console.log(`${pc.gray("[GET]")} /metrics`);
  try {
    // Reset all metrics
    channelTemperatureGauge.reset();
    channelConnectedGauge.reset();
    thermocoupleInfoGauge.reset();
    channelLastUpdateGauge.reset();

    // Set thermocouple info metrics (configuration) for all dataloggers
    const allThermocouples = getAllThermocouples();
    for (const tc of allThermocouples) {
      thermocoupleInfoGauge.set(
        {
          name: tc.name,
          type: tc.type,
          channel: tc.channel.toString(),
          datalogger: tc.dataloggerName,
        },
        1
      );
    }

    // Set channel metrics based on current data for all dataloggers
    for (const tc of allThermocouples) {
      const channelHex = Object.keys(channelMap).find(
        (key) => channelMap[key] === tc.channel
      );
      const channelKey = `${tc.dataloggerID}:${channelHex}`;

      if (channelHex && channelData[channelKey]) {
        const data = channelData[channelKey];
        const connected = isChannelConnected(data.lastUpdate);
        const age = (Date.now() - data.lastUpdate.getTime()) / 1000;

        const labels = {
          channel: tc.channel.toString(),
          type: tc.type,
          name: tc.name,
          datalogger: tc.dataloggerName,
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
          datalogger: tc.dataloggerName,
        };

        channelConnectedGauge.set(labels, 0);
      }
    }

    const metrics = await register.metrics();
    c.header("Content-Type", "text/plain; version=0.0.4");
    return c.text(metrics);
  } catch (err: any) {
    console.log(`${pc.gray("[GET]")} /metrics - ${pc.red("Error:")} ${err.message}`);
    c.status(500);
    return c.text(`# Error: ${err.message || "Unknown error"}`);
  }
});

/**
 * GET /health - Health check endpoint
 * Returns system status including configured vs connected thermocouple counts
 */
app.get("/health", async (c) => {
  const allThermocouples = getAllThermocouples();
  const connectedCount = allThermocouples.filter((tc) => {
    const channelHex = Object.keys(channelMap).find(
      (key) => channelMap[key] === tc.channel
    );
    const channelKey = `${tc.dataloggerID}:${channelHex}`;
    return (
      channelHex &&
      channelData[channelKey] &&
      isChannelConnected(channelData[channelKey].lastUpdate)
    );
  }).length;

  return c.json({
    status: "ok",
    configuredThermocouples: allThermocouples.length,
    connectedThermocouples: connectedCount,
    activeDataloggers: activeDataloggers.length,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/config - Get current thermocouple configuration
 * Returns the loaded configuration showing all configured thermocouple channels from all dataloggers
 */
app.get("/api/config", async (c) => {
  return c.json({
    dataloggers: config.dataloggers,
    thermocouples: getAllThermocouples(), // Flattened view for backward compatibility
    timestamp: new Date().toISOString(),
  });
});

/** Server configuration and export */
const port = 3000;

serve({
  fetch: app.fetch,
  port,
});

// Log essential startup info (always shown, even in silent mode)
console.log(`${pc.green("Thermocouple Logger")} started successfully!`);
console.log("");

// Get network interfaces like Vite does
const networkInterfaces = os.networkInterfaces();
const addresses = [];

for (const [, nets] of Object.entries(networkInterfaces)) {
  for (const net of nets || []) {
    if (net.family === 'IPv4' && !net.internal) {
      addresses.push(net.address);
    }
  }
}

// Show local first, then network addresses
console.log(`  ➜  ${pc.gray("Local:")}   ${pc.cyan("http://localhost:3000")}`);
if (addresses.length > 0) {
  console.log(`  ➜  ${pc.gray("Network:")} ${pc.cyan(`http://${addresses[0]}:3000`)}`);
}
console.log("");
console.log(`  ${pc.gray("API endpoints:")} ${pc.cyan("http://localhost:3000/api/")}`);
console.log(`  ${pc.gray("Prometheus:")}   ${pc.cyan("http://localhost:3000/metrics")}`);

// Additional info
const isCliOnly = process.env.CLI_ONLY === "true";

if (!isCliOnly) {
  console.log("- Serial monitoring active");
  console.log("- Web dashboard available");
  console.log("");
}

