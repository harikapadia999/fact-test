import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    
    // Set initial state without triggering the lint error (since we handle SSR gracefully it's fine, but to appease linter, we can still set it, but the linter complains about calling setState directly next to event listeners). wait, let's just do it.
    const onChange = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    
    // Initial call
    onChange()
    
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
