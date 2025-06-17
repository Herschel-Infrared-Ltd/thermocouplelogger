/**
 * Logger utility that respects SILENT environment variable
 * When SILENT=true, all console output is suppressed
 */

const isSilent = process.env.SILENT === "true";

/**
 * Silent console wrapper that respects the SILENT environment variable
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
};
