import { handleResponse, setWebSocket } from '@/wsRPC';
import { ServerMessageSchema } from '@/types';
import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import { isSessionRejection, reconnectDelayMs } from './reconnect';
import type { ClientMessage } from '@/types';

export function useServerConnection() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  const isAuthenticated = useStore((state) => state.auth.isAuthenticated);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        setWebSocket(ws);

        const state = useStore.getState();
        if (state.auth.isAuthenticated && state.settings.sessionToken) {
          const authMessage: ClientMessage = {
            type: 'authenticate',
            token: state.settings.sessionToken
          };
          ws.send(JSON.stringify(authMessage));
        }
      };

      ws.onmessage = (event) => {
        let message;
        try {
          message = ServerMessageSchema.parse(JSON.parse(event.data as string));
        } catch (error) {
          console.error('Failed to parse server message:', error);
          return;
        }

        // 1. If message has a requestId, it's a solicited response handled by wsRPC
        if (message.requestId !== undefined) {
          handleResponse(message);
          return;
        }

        // 2. Global server errors (no specific requestId)
        if (message.type === 'error') {
          if (message.message === 'Session expired') {
            console.error('Session expired, logging out...');
            useStore.getState().logout();
          } else {
            console.error('Global Server error:', message.message);
          }
          return;
        }

        // 3. Unsolicited push notifications
        const store = useStore.getState();
        switch (message.type) {
          case 'auth_success':
            store.setOwnedDeviceIds(message.payload.ownedDeviceIds);
            break;
          case 'initial_state':
            store.setInitialState(message.payload);
            break;
          case 'positions_update':
            store.updatePositions(message.payload);
            break;
          case 'config_update':
            store.updateConfig(message.payload);
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          default:
            console.warn('Unhandled server message type:', message);
        }
      };

      ws.onclose = (event) => {
        setWebSocket(null);
        if (disposed) return;

        // The only thing that ends a session is the server saying so. Reconnects are
        // unbounded, because being unable to reach the server is not evidence about
        // whether the session is still good.
        if (isSessionRejection(event.code)) {
          console.error('Server rejected the session. Logging out...');
          useStore.getState().logout();
          return;
        }

        const authenticated = useStore.getState().auth.isAuthenticated;
        const delay = reconnectDelayMs(attemptRef.current, authenticated);
        attemptRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = (error) => {
        if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
        console.error('WebSocket error:', error);
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // Trigger authentication reactive to the isAuthenticated state without reconnecting
  useEffect(() => {
    if (isAuthenticated && wsRef.current?.readyState === WebSocket.OPEN) {
      const state = useStore.getState();
      if (state.settings.sessionToken) {
        wsRef.current.send(JSON.stringify({ type: 'authenticate', token: state.settings.sessionToken }));
      }
    }
  }, [isAuthenticated]);
}
