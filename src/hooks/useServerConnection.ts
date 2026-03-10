import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import type { ServerMessage, ClientMessage } from '@/types';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export function useServerConnection() {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    auth,
    settings,
    setInitialState,
    updatePositions,
    updateConfig,
  } = useStore();

  useEffect(() => {
    // Only connect if the user is logged in
    if (!auth.isAuthenticated) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setStatus('disconnected');
      return;
    }

    const connect = () => {
      setStatus('connecting');

      // Uses same origin in production, or localhost:3000 in dev proxy
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        
        // Let the server know who this is, and prove they have traccar session
        const authMessage: ClientMessage = {
          type: 'authenticate',
          // Build a basic auth token from current credentials to verify session on backend
          token: btoa(`${settings.email}:${settings.password}`)
        };
        ws.send(JSON.stringify(authMessage));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;

          switch (message.type) {
            case 'initial_state':
              setInitialState(message.payload);
              break;
            case 'positions_update':
              updatePositions(message.payload);
              break;
            case 'config_update':
              updateConfig(message.payload);
              break;
            default:
              console.warn('Unknown server message type:', message);
          }
        } catch (error) {
          console.error('Failed to parse server message:', error);
        }
      };

      ws.onclose = () => {
        setStatus('disconnected');
        // Auto-reconnect if we are still authenticated
        if (useStore.getState().auth.isAuthenticated) {
          reconnectTimeoutRef.current = setTimeout(connect, 5000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setStatus('error');
      };
    };

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [auth.isAuthenticated, setInitialState, updatePositions, updateConfig]);

  return { status };
}
