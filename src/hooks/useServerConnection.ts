import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { setWebSocket } from '@/wsClient';
import type { ServerMessage, ClientMessage } from '@/types';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

import { handleResponse } from '@/wsRPC';

export function useServerConnection() {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    auth,
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
        setWebSocket(ws);

        const currentToken = useStore.getState().settings.sessionToken;
        if (!currentToken) {
          console.error("No session token found");
          return;
        }
        const authMessage: ClientMessage = {
          type: 'authenticate',
          token: currentToken
        };
        ws.send(JSON.stringify(authMessage));
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;

          if (parsed && typeof parsed === 'object' && 'requestId' in parsed && parsed['requestId']) {
            handleResponse(parsed as { requestId: string;[key: string]: unknown }); // Let handleResponse deal with casting
            const msgType = String(parsed['type']);
            if (msgType === 'error' || msgType.endsWith('_success')) {
              return;
            }
          }

          // Handle regular broadcast messages
          const message = parsed as ServerMessage;

          if (message.type === 'error' && message.message === 'Session expired') {
            console.error('Session expired, logging out...');
            useStore.getState().logout();
            return;
          }

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

      ws.onclose = (event) => {
        setWebSocket(null);
        setStatus('disconnected');

        // If the server closed the connection due to policy violation (e.g. auth failed),
        // we should log the user out and not attempt to reconnect blindly.
        if (event.code === 1008) {
          console.error('WebSocket closed with policy violation (auth failed). Logging out...');
          useStore.getState().logout();
          return;
        }

        // Auto-reconnect if we are still authenticated
        if (useStore.getState().auth.isAuthenticated) {
          reconnectTimeoutRef.current = setTimeout(connect, 5000);
        }
      };

      ws.onerror = (error) => {
        // Suppress generic errors if the socket is already closing or closed
        if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;

        console.error('WebSocket error:', error);
        setStatus('error');
        ws.close();
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
