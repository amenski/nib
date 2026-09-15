/**
 * Nib ErrorBoundary — Graceful error handling for the Ink TUI.
 *
 * Wraps the App component tree so that uncaught React render errors
 * display a recoverable message instead of crashing the terminal.
 */

import React, { Component, type ErrorInfo } from "react";
import { Text, Box } from "ink";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Whether colors are enabled (for ANSI fallback) */
  colorEnabled?: boolean;
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
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box>
            <Text bold color="red">
              {" ⚠ An unexpected error occurred"}
            </Text>
          </Box>
          <Box>
            <Text dimColor>
              {this.state.error?.message ?? "Unknown error"}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
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
