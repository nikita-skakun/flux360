import { handleResponse, setWebSocket } from '@/wsRPC';
import { ServerMessageSchema } from '@/types';
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
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
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
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          default:
            console.warn('Unhandled server message type:', message);
        }
      };

      ws.onclose = (event) => {
        setWebSocket(null);

        if (event.code === 1008) {
          console.error('WebSocket closed with policy violation (auth failed). Logging out...');
          useStore.getState().logout();
          return;
        }

        // If we were previously authenticated, reset the fast-retry counter for this new failure cycle.
        if (preAuthRetryCountRef.current === -1) preAuthRetryCountRef.current = 0;

        // Always attempt reconnect unless component is unmounting
        if (preAuthRetryCountRef.current >= 0 && preAuthRetryCountRef.current < 2) {
          preAuthRetryCountRef.current += 1;
          reconnectTimeoutRef.current = setTimeout(connect, AUTH_RETRY_DELAY_MS);
          return;
        }

        // If we've reached the limit and were supposed to be authenticated, force a logout to resolve the stale session.
        if (auth.isAuthenticated) {
          console.error('Handshake failed repeatedly. Session state may be invalid. Logging out...');
          useStore.getState().logout();
          return;
        }

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
  }, [setInitialState, setOwnedDeviceIds, updatePositions, updateConfig]);

  // Trigger authentication reactive to the isAuthenticated state without reconnecting
  useEffect(() => {
    if (auth.isAuthenticated && wsRef.current?.readyState === WebSocket.OPEN) {
      const state = useStore.getState();
      if (state.settings.sessionToken) {
        wsRef.current.send(JSON.stringify({ type: 'authenticate', token: state.settings.sessionToken }));
      }
    }
  }, [auth.isAuthenticated]);
}
