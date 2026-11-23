import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

export interface RealtimeEvent {
  type:
    | 'BID_CREATED'
    | 'BID_ACCEPTED'
    | 'BOOKING_UPDATED'
    | 'GPS_UPDATE'
    | 'CHANGE_ORDER_PROPOSED'
    | 'CHANGE_ORDER_RESPONDED'
    | 'CHAT_MESSAGE'
    | 'DISPUTE_OPENED'
    | 'SOS_P0_ALERT'
    | 'ANTI_LEAKAGE_FLAG'
    | 'AMC_EMERGENCY_ALERT';
  bookingId?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

class RealtimeHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(
        JSON.stringify({
          type: 'CONNECTED',
          timestamp: new Date().toISOString(),
        })
      );
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  broadcast(event: Omit<RealtimeEvent, 'timestamp'>): void {
    const message = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

export const realtimeHub = new RealtimeHub();
