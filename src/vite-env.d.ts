/// <reference types="vite/client" />

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (payload: unknown) => void) => void
  removeListener?: (event: string, handler: (payload: unknown) => void) => void
}

interface Window {
  ethereum?: EthereumProvider
}
