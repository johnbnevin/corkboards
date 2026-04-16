import React from 'react'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
  /** When true, removeChild errors trigger a full page reload instead of re-render
   *  (re-rendering into a corrupt DOM creates duplicate UI trees). */
  reloadOnDomError?: boolean
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo)
    const isDomError = error.name === 'NotFoundError' || error.message?.includes('removeChild')
    if (isDomError) {
      if (this.props.reloadOnDomError) {
        // DOM is corrupt — re-rendering would create duplicate UI trees.
        // Full reload is the only safe recovery.
        console.warn('[ErrorBoundary] DOM corruption detected, reloading page')
        setTimeout(() => window.location.reload(), 200)
        return
      }
      // Inner (scoped) boundaries can safely re-render since their subtree
      // gets a clean unmount/remount via React's keyed reconciliation.
      setTimeout(() => this.setState({ hasError: false, error: null }), 100)
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="p-4 text-red-500">
          <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
          <p className="mb-3">An unexpected error occurred.</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-red-100 hover:bg-red-200 dark:bg-red-900 dark:hover:bg-red-800 text-red-700 dark:text-red-300 rounded text-sm"
          >
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary