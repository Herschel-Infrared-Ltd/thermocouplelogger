# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Main Commands

- `npm run setup` - Interactive setup to configure serial port (channels auto-detected)
- `npm start` - Start complete application (serial monitoring + web server + live dashboard)
- `npm run server` - Start web server only

### CLI Mode

- `npm run cli` - CLI-only mode (tables only, no web server)

## Application Architecture

### Core Components

- `index.ts` - Main entry point: serial monitoring + web server + live dashboard
- `server.ts` - Hono web server with REST API and Prometheus metrics
- `config.ts` - Configuration management and setup utilities
- `parser.ts` - Shared HH-4208SD data parsing logic with validation

### Data Flow

1. Serial data received from HH-4208SD thermocouple logger via RS-232
2. Raw data logged and processed through shared `parser.ts` module
3. Parser validates STX headers and hex channel identifiers (0x41-0x4C for channels 1-12)
4. Valid messages trigger auto-detection and temperature data storage
5. Temperature data stored in `channelData` object indexed by hex channel ID
6. Web server exposes data via REST API endpoints and Prometheus metrics
7. Frontend displays real-time data via periodic API calls

### Key Data Structures

- `channelData` - Global storage for temperature readings, indexed by hex channel ID
- `channelMap` - Maps hex identifiers (41-4C) to decimal channel numbers (1-12)
- `config` - Loaded configuration with serial port settings and thermocouple definitions

### Configuration

- `config.json` - Optional configuration file for serial port and channel customization
- **Auto-detection mode**: App works without config - channels detected from live data
- **Setup mode**: Run `npm run setup` to configure serial port and customize channel names
- Configuration enhances auto-detected channels rather than defining them

## Auto-Detection System

### Multi-Datalogger Support
- **Multiple devices**: Supports connecting multiple HH-4208SD dataloggers simultaneously
- **Auto-detection**: Automatically detects and configures multiple dataloggers
- **Unique naming**: Uses "D1-T1", "D2-T3" format for thermocouple names across dataloggers
- **Port scoring**: Intelligent port scoring system prioritizes likely datalogger devices

### Channel Discovery
- **Dynamic Detection**: Channels automatically detected when first data arrives
- **Smart Defaults**: Auto-generated names ("D1-T1", "D1-T2") and Type K thermocouples
- **Configuration Overlay**: User config overrides defaults for matching channels
- **No Pre-configuration**: Works immediately without channel setup

### Detection Metadata
- `detected: boolean` - Whether channel was auto-detected vs pre-configured
- `firstSeen: Date` - Timestamp when channel was first detected
- `dataCount: number` - Total data points received for the channel
- `lastUpdate: Date` - Most recent data timestamp

### Workflow
1. **Run setup** - `npm run setup` for guided serial port configuration
2. **Configure HH-4208SD** - sampling rate "1", USB switch position "2" 
3. **Connect thermocouples** to desired channels on HH-4208SD
4. **Start monitoring** - `npm start` begins auto-detection
5. **Active channels appear** automatically as data arrives
6. **Customize names** by editing config.json (optional)

### Setup Process
- **Enhanced setup wizard** with HH-4208SD configuration guidance
- **Automatic port testing** - validates data format during setup
- **Smart port filtering** - highlights likely USB-to-serial devices
- **Graceful fallbacks** - continues if data validation fails
- **Hardware-specific instructions** for sampling rate and cable switch

## Hardware Integration

### Serial Communication

- Protocol: RS-232 with custom data format
- Default baud rate: 9600
- Message format: STX + 2-char hex channel ID + sensor data + temperature (last 3 digits)
- Connection timeout: 60 seconds for channel disconnection detection

### Thermocouple Channels

- Supports up to 12 channels (1-12)
- Channel hex mapping: 0x41-0x4C
- Multiple thermocouple types supported (K, J, T, E, R, S)

### HH-4208SD Setup Requirements

- **Sampling rate**: Set to "1" (1 second intervals)
- **USB cable switch**: Position "2" (photo mode) - CRITICAL for data format
- **Data logging**: Must be enabled on device
- **Data format validation**: Setup automatically tests for valid STX + channel ID format

## API Endpoints

### Core Endpoints

- `GET /api/readings` - All active channels (detected + configured) with metadata
- `GET /api/readings/:name` - Specific thermocouple reading by name  
- `GET /api/config` - Current configuration
- `GET /health` - System health check
- `GET /metrics` - Prometheus metrics

### Enhanced API Response
- `totalActive` - Number of channels currently active
- `totalDetected` - Number of auto-detected channels
- `totalConfigured` - Number of pre-configured channels
- Per-channel: `detected`, `firstSeen`, `dataCount` metadata

### Metrics

- `thermocouple_channel_temperature` - Current temperature readings
- `thermocouple_channel_connected` - Connection status (1=connected, 0=disconnected)
- `thermocouple_channel_last_update_seconds` - Data age in seconds

## Development Notes

### Testing and Linting

- **No test framework**: Currently no unit tests or testing framework configured
- **No linting**: No ESLint or similar linting tools configured
- **TypeScript validation**: Uses strict TypeScript checking for type safety
- **Manual testing**: Use hardware setup and `npm run setup` for integration testing

### TypeScript Configuration

- Uses latest ESNext features with strict type checking
- Module resolution set to "bundler" mode
- Allows importing .ts extensions

### Runtime Behavior

- **Zero-config startup**: App runs without config.json in auto-detection mode
- **Graceful serial failures**: Continues in demo mode if serial port unavailable
- **Dynamic channel creation**: New channels auto-created when data received
- **Raw data logging**: All incoming serial data logged for debugging/iteration
- **Shared parsing**: Consistent data validation across setup and runtime
- **60-second timeout**: Channels considered disconnected after no data
- **Live dashboard**: Console table updates every 2 seconds with ANSI escape codes
- **Dashboard logging**: Individual events appear above live table in dashboard mode
- **Port 3000**: Web server always runs on localhost:3000
- **CLI mode**: CLI_ONLY=true shows only tables, no web server
- **Server mode**: Default mode - starts web server and shows CLI tables (unless CLI_ONLY=true)

### Console Dashboard Features

- **Live table updates**: Dynamic temperature table refreshes in place without scrolling
- **ANSI terminal control**: Uses escape codes for cursor positioning and screen clearing
- **Dashboard logging**: Events and messages appear above the live table
- **Immediate updates**: Table refreshes on new data arrival plus periodic 2-second updates
- **Dashboard toggle**: Automatically enabled 1 second after startup messages (CLI mode only)

### Error Handling

- **Optional configuration**: No process exit if config missing or invalid
- **Serial port resilience**: Graceful handling of connection failures
- **API stability**: Appropriate HTTP status codes for all conditions
- **Auto-recovery**: Channels auto-reconnect when data resumes

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
