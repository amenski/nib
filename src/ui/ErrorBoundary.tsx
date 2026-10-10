/**
 * Nib ErrorBoundary — Graceful error handling for the Ink TUI.
 *
 * Wraps the App component tree so that uncaught React render errors
 * display a recoverable message instead of crashing the terminal.
 */

import React, { Component, type ErrorInfo } from "react";
import { Text, Box } from "ink";
import { ansi256, type ThemeContextValue } from "./theme.js";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Whether colors are enabled (for ANSI fallback) */
  colorEnabled?: boolean;
  /** Resolved theme, so the crash screen follows the user's slots. */
  theme?: ThemeContextValue;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
    // Also write to stderr so it's captured in logs
    process.stderr.write(
      `[ErrorBoundary] ${error.message}\n${errorInfo.componentStack ?? ""}\n`,
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const tc = this.props.theme;
      const errorColor = tc && this.props.colorEnabled ? ansi256(tc.theme.error) : undefined;
      const dimColor = tc && this.props.colorEnabled ? ansi256(tc.theme.textDim) : undefined;
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box>
            <Text bold color={errorColor}>
              {" ⚠ An unexpected error occurred"}
            </Text>
          </Box>
          <Box>
            <Text color={dimColor}>
              {this.state.error?.message ?? "Unknown error"}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={dimColor}>
              {"  Press "}
              <Text bold>Ctrl+C</Text>
              {" to restart nib, or type "}
              <Text bold>/exit</Text>
              {" to quit."}
            </Text>
          </Box>
        </Box>
      );
    }

    return this.props.children;
  }
}
