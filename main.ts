#!/usr/bin/env node

/**
 * Main entry point for the Thermocouple Logger application
 * Starts both the serial data monitoring and web server
 */

import "./index.js"; // Start serial monitoring
import "./server.js"; // Start web server

console.log("Thermocouple Logger started successfully!");
console.log("- Serial monitoring active");
console.log("- Web dashboard available at http://localhost:3000");
console.log("- API endpoints available at http://localhost:3000/api/");
console.log("- Prometheus metrics at http://localhost:3000/metrics");
