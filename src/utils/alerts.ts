// src/utils/alerts.ts

import { logger } from './logging';

export enum AlertChannel {
  EMAIL = 'email',
  SLACK = 'slack',
  SMS = 'sms',
  PUSH = 'push',
  CONSOLE = 'console'
}

export enum AlertSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical'
}

interface AlertConfig {
  channels: AlertChannel[];
  recipients: {
    email: string[];
    slack: string[];
    sms: string[];
    push: string[];
  };
  thresholds: {
    [key: string]: {
      count: number;
      window: number;
    };
  };
  enabled: boolean;
  developmentLogging: boolean;
}

const DEFAULT_CONFIG: AlertConfig = {
  channels: [AlertChannel.EMAIL, AlertChannel.SLACK],
  recipients: {
    email: ['admin@safeguard.mw', 'it-team@safeguard.mw'],
    slack: ['#alerts'],
    sms: ['+265881234567'],
    push: ['admin']
  },
  thresholds: {
    error: { count: 10, window: 5 * 60 * 1000 },
    critical: { count: 1, window: 0 },
    warning: { count: 20, window: 5 * 60 * 1000 }
  },
  enabled: process.env.NODE_ENV === 'production',
  developmentLogging: true
};

interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: Date;
  data?: any;
  source?: string;
}

// ===== SAFE STRINGIFY FUNCTION =====
const safeStringify = (value: any): string => {
  try {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
    return String(value);
  } catch {
    return '[Unable to convert]';
  }
};

// ===== AlertManager CLASS =====
class AlertManager {
  private config: AlertConfig;
  private errorCount: number = 0;
  private warningCount: number = 0;
  private lastReset: number = Date.now();
  private alertHistory: Alert[] = [];
  private maxHistorySize: number = 1000;

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startResetTimer();
  }

  private startResetTimer() {
    setInterval(() => {
      const now = Date.now();
      if (now - this.lastReset > this.config.thresholds.error.window) {
        this.errorCount = 0;
        this.warningCount = 0;
        this.lastReset = now;
      }
    }, 60000);
  }

  sendAlert(
    severity: AlertSeverity,
    title: string,
    message: string,
    data?: any
  ): void {
    if (!this.config.enabled) {
      if (this.config.developmentLogging) {
        console.log(`[ALERT] ${severity}: ${title} - ${message}`, data);
      }
      return;
    }

    const alert: Alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      severity,
      title,
      message,
      timestamp: new Date(),
      data,
      source: window.location.hostname
    };

    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory.shift();
    }

    if (this.config.enabled) {
      logger.warn(`Alert: ${severity} - ${title}`, { message, data });
    }
    
    this.checkThresholds(severity, alert);

    switch (severity) {
      case AlertSeverity.CRITICAL:
        this.sendCriticalAlert(alert);
        break;
      case AlertSeverity.ERROR:
        this.sendErrorAlert(alert);
        break;
      case AlertSeverity.WARNING:
        this.sendWarningAlert(alert);
        break;
      default:
        this.sendInfoAlert(alert);
        break;
    }
  }

  private checkThresholds(severity: AlertSeverity, _alert: Alert) {
    switch (severity) {
      case AlertSeverity.ERROR:
        this.errorCount++;
        if (this.errorCount >= this.config.thresholds.error.count) {
          this.sendAlert(
            AlertSeverity.CRITICAL,
            'High Error Rate Detected',
            `${this.errorCount} errors occurred in the last ${this.config.thresholds.error.window / 1000} seconds`,
            { count: this.errorCount, window: this.config.thresholds.error.window }
          );
          this.errorCount = 0;
        }
        break;
        
      case AlertSeverity.WARNING:
        this.warningCount++;
        if (this.warningCount >= this.config.thresholds.warning.count) {
          this.sendAlert(
            AlertSeverity.ERROR,
            'High Warning Rate Detected',
            `${this.warningCount} warnings occurred in the last ${this.config.thresholds.warning.window / 1000} seconds`,
            { count: this.warningCount, window: this.config.thresholds.warning.window }
          );
          this.warningCount = 0;
        }
        break;
    }
  }

  private sendCriticalAlert(alert: Alert) {
    this.sendToEmail(alert);
    this.sendToSlack(alert);
    this.sendToSMS(alert);
    this.sendToPush(alert);
  }

  private sendErrorAlert(alert: Alert) {
    this.sendToEmail(alert);
    this.sendToSlack(alert);
  }

  private sendWarningAlert(alert: Alert) {
    this.sendToSlack(alert);
  }

  private sendInfoAlert(alert: Alert) {
    if (this.config.developmentLogging) {
      console.log(`[INFO] ${alert.title}: ${alert.message}`);
    }
  }

  private sendToEmail(alert: Alert) {
    if (!this.config.enabled) {
      if (this.config.developmentLogging) {
        console.log(`📧 [DEV] Email alert: ${alert.title}`);
      }
      return;
    }
    console.log(`📧 Sending email alert: ${alert.title} to ${this.config.recipients.email.join(', ')}`);
  }

  private sendToSlack(alert: Alert) {
    if (!this.config.enabled) {
      if (this.config.developmentLogging) {
        console.log(`💬 [DEV] Slack alert: ${alert.title}`);
      }
      return;
    }
    console.log(`💬 Sending Slack alert: ${alert.title} to ${this.config.recipients.slack.join(', ')}`);
  }

  private sendToSMS(alert: Alert) {
    if (!this.config.enabled) {
      if (this.config.developmentLogging) {
        console.log(`📱 [DEV] SMS alert: ${alert.title}`);
      }
      return;
    }
    console.log(`📱 Sending SMS alert: ${alert.title} to ${this.config.recipients.sms.join(', ')}`);
  }

  private sendToPush(alert: Alert) {
    if (!this.config.enabled) {
      if (this.config.developmentLogging) {
        console.log(`🔔 [DEV] Push alert: ${alert.title}`);
      }
      return;
    }
    console.log(`🔔 Sending push notification: ${alert.title}`);
  }

  getAlertHistory(severity?: AlertSeverity): Alert[] {
    if (severity) {
      return this.alertHistory.filter(a => a.severity === severity);
    }
    return this.alertHistory;
  }

  clearHistory(): void {
    this.alertHistory = [];
  }
}

// ===== EXPORT INSTANCE =====
export const alertManager = new AlertManager();

// ===== EXPORT FUNCTIONS WITH SAFE STRINGIFY =====
export const triggerAlert = (
  severity: AlertSeverity,
  title: string,
  message: string,
  data?: any
) => {
  alertManager.sendAlert(severity, title, message, data);
};

export const triggerError = (message: string, error?: any, data?: any) => {
  // Use safeStringify for error objects
  const safeError = error ? safeStringify(error) : error;
  const safeData = data ? safeStringify(data) : data;
  if (process.env.NODE_ENV !== 'production') {
    console.error(`[ERROR] ${message}`, safeError, safeData);
    return;
  }
  triggerAlert(AlertSeverity.ERROR, 'Error Occurred', message, { error: safeError, data: safeData });
};

export const triggerCritical = (message: string, error?: any, data?: any) => {
  const safeError = error ? safeStringify(error) : error;
  const safeData = data ? safeStringify(data) : data;
  if (process.env.NODE_ENV !== 'production') {
    console.error(`[CRITICAL] ${message}`, safeError, safeData);
    return;
  }
  triggerAlert(AlertSeverity.CRITICAL, 'Critical Error', message, { error: safeError, data: safeData });
};

export const triggerWarning = (message: string, data?: any) => {
  const safeData = data ? safeStringify(data) : data;
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[WARNING] ${message}`, safeData);
    return;
  }
  triggerAlert(AlertSeverity.WARNING, 'Warning', message, { data: safeData });
};

// ===== SIMPLIFIED: startMonitoring with safe error handling =====
export const startMonitoring = () => {
  // In development, just log a message
  if (process.env.NODE_ENV !== 'production') {
    console.log('🔍 Monitoring active (development)');
    return;
  }

  // Production: Store original console methods
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleLog = console.log;

  // Only override console.error in production
  if (process.env.NODE_ENV === 'production') {
    console.error = function(...args) {
      originalConsoleError.apply(console, args);
      // Don't trigger alerts from console errors to avoid recursion
    };
  }

  // ===== FIXED: Error event listener with safe handling =====
  window.addEventListener('error', (event) => {
    // Use separate arguments, NOT template literals
    originalConsoleError.call(console, 'Unhandled Error:', event.message || event);
    
    if (process.env.NODE_ENV === 'production') {
      try {
        const errorMsg = typeof event.message === 'string' 
          ? event.message 
          : safeStringify(event.error || event);
        triggerError('Unhandled JavaScript Error', errorMsg, {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        });
      } catch (e) {
        originalConsoleError.call(console, 'Alert failed:', e);
      }
    }
  });

  // ===== FIXED: Unhandled rejection listener with safe handling =====
  window.addEventListener('unhandledrejection', (event) => {
    // Use separate arguments, NOT template literals
    originalConsoleError.call(console, 'Unhandled Rejection:', event.reason || event);
    
    if (process.env.NODE_ENV === 'production') {
      try {
        const reasonMsg = typeof event.reason === 'string'
          ? event.reason
          : safeStringify(event.reason || 'Unknown rejection');
        triggerError('Unhandled Promise Rejection', reasonMsg, {
          promise: event.promise
        });
      } catch (e) {
        originalConsoleError.call(console, 'Alert failed:', e);
      }
    }
  });

  // Online/Offline listeners
  window.addEventListener('online', () => {
    if (process.env.NODE_ENV === 'production') {
      try {
        logger.info('Network connection restored');
      } catch (e) {
        originalConsoleLog.call(console, 'Network restored');
      }
    } else {
      console.log('📶 Network connection restored');
    }
  });
  
  window.addEventListener('offline', () => {
    if (process.env.NODE_ENV === 'production') {
      try {
        triggerWarning('Network connection lost');
      } catch (e) {
        originalConsoleWarn.call(console, 'Network lost');
      }
    } else {
      console.warn('📶 Network connection lost');
    }
  });

  if (process.env.NODE_ENV === 'production') {
    try {
      logger.info('Monitoring started');
    } catch (e) {
      console.log('Monitoring started');
    }
  } else {
    console.log('✅ Monitoring started in development mode');
  }
};