import { handleResponse } from '@/wsRPC';
import { ServerMessageSchema } from '@/types';
import { setWebSocket } from '@/wsClient';
import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import type { ClientMessage } from '@/types';

export function useServerConnection() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { auth, setInitialState, setOwnedDeviceIds, updatePositions, updateConfig } = useStore();

  useEffect(() => {
    if (!auth.isAuthenticated) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
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
          const raw = JSON.parse(String(event.data)) as unknown;
          const message = ServerMessageSchema.parse(raw);

          if (message.type === 'error') {
            if (message.message === 'Session expired') {
              console.error('Session expired, logging out...');
              useStore.getState().logout();
            } else if (message.requestId !== null) {
              handleResponse(message);
            } else {
              console.error('Server error:', message.message);
            }
            return;
          }

          if (message.type === 'update_success' || message.type === 'create_success' || message.type === 'delete_success') {
            handleResponse(message);
            return;
          }

          switch (message.type) {
            case 'auth_success':
              setOwnedDeviceIds(message.payload.ownedDeviceIds);
              break;
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

        if (event.code === 1008) {
          console.error('WebSocket closed with policy violation (auth failed). Logging out...');
          useStore.getState().logout();
          return;
        }

        if (useStore.getState().auth.isAuthenticated)
          reconnectTimeoutRef.current = setTimeout(connect, 5000);
      };

      ws.onerror = (error) => {
        if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
        console.error('WebSocket error:', error);
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
  }, [auth.isAuthenticated, setInitialState, setOwnedDeviceIds, updatePositions, updateConfig]);
}
