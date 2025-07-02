/**
 * Logger utility that respects SILENT environment variable
 * When SILENT=true, all console output is suppressed
 * Supports dashboard mode for dynamic table updates
 */

const isSilent = process.env.SILENT === "true";

/**
 * Dashboard state tracking
 */
let dashboardMode = false;
let dashboardLines = 0;

/**
 * ANSI escape codes for terminal control
 */
const ANSI = {
  CLEAR_SCREEN: '\x1b[2J\x1b[H',
  MOVE_UP: (lines: number) => `\x1b[${lines}A`,
  CLEAR_LINE: '\x1b[K',
  CLEAR_DOWN: '\x1b[J',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
};

/**
 * Silent console wrapper that respects the SILENT environment variable
 * Extended with dashboard functionality for live table updates
 */
export const logger = {
  log: (...args: any[]) => {
    if (!isSilent) {
      console.log(...args);
    }
  },

  error: (...args: any[]) => {
    if (!isSilent) {
      console.error(...args);
    }
  },

  warn: (...args: any[]) => {
    if (!isSilent) {
      console.warn(...args);
    }
  },

  info: (...args: any[]) => {
    if (!isSilent) {
      console.info(...args);
    }
  },

  /**
   * Enable dashboard mode for dynamic table updates
   */
  enableDashboard: () => {
    if (!isSilent) {
      dashboardMode = true;
      // Clear screen and show initial dashboard
      process.stdout.write(ANSI.CLEAR_SCREEN);
    }
  },

  /**
   * Disable dashboard mode and return to normal logging
   */
  disableDashboard: () => {
    dashboardMode = false;
    dashboardLines = 0;
  },

  /**
   * Update the dashboard table (clears previous and redraws)
   */
  updateDashboard: (content: string) => {
    if (isSilent || !dashboardMode) return;

    // Move cursor up to overwrite previous dashboard
    if (dashboardLines > 0) {
      process.stdout.write(ANSI.MOVE_UP(dashboardLines));
      process.stdout.write(ANSI.CLEAR_DOWN);
    }

    // Write new content
    process.stdout.write(content);
    
    // Count lines in content for next update
    dashboardLines = content.split('\n').length;
  },

  /**
   * Log a message in dashboard mode (appears above the table)
   */
  dashboardLog: (message: string) => {
    if (isSilent) return;
    
    if (dashboardMode) {
      // Move up, insert line, move back down
      if (dashboardLines > 0) {
        process.stdout.write(ANSI.MOVE_UP(dashboardLines));
      }
      console.log(message);
    } else {
      console.log(message);
    }
  },

  /**
   * Check if dashboard mode is active
   */
  isDashboardMode: () => dashboardMode,
};
