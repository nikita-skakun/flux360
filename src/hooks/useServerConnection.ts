import { handleResponse } from '@/wsRPC';
import { ServerMessageSchema } from '@/types';
import { setWebSocket } from '@/wsClient';
import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import type { ClientMessage } from '@/types';

const AUTH_RETRY_DELAY_MS = 500;
const RECONNECT_DELAY_MS = 5000;

export function useServerConnection() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // -1 means auth succeeded for current socket, >=0 counts pre-auth closes.
  const preAuthRetryCountRef = useRef(0);

  const { auth, setInitialState, setOwnedDeviceIds, updatePositions, updateConfig } = useStore();

  useEffect(() => {
    if (!auth.isAuthenticated) {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      preAuthRetryCountRef.current = 0;
      return;
    }

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      preAuthRetryCountRef.current = 0;

      ws.onopen = () => {
        setWebSocket(ws);

        const currentToken = useStore.getState().settings.sessionToken;
        if (!currentToken) {
          console.error('No session token found');
          useStore.getState().logout();
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
              preAuthRetryCountRef.current = -1;
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

        if (!useStore.getState().auth.isAuthenticated) return;

        // If the socket closes before auth succeeds, retry quickly once.
        // A second pre-auth close likely means invalid/expired session.
        if (preAuthRetryCountRef.current >= 0 && preAuthRetryCountRef.current < 2) {
          preAuthRetryCountRef.current += 1;
          reconnectTimeoutRef.current = setTimeout(connect, AUTH_RETRY_DELAY_MS);
          return;
        }

        if (preAuthRetryCountRef.current === 2) {
          preAuthRetryCountRef.current += 1;
          console.error('Authentication handshake failed repeatedly. Logging out...');
          useStore.getState().logout();
          return;
        }

        preAuthRetryCountRef.current = -1;
        reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
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
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [auth.isAuthenticated, setInitialState, setOwnedDeviceIds, updatePositions, updateConfig]);
}
