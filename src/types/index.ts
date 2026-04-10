import { z } from "zod";

export const Vec2Schema = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2Schema>;

declare const WEB_MERCATOR_COORD_BRAND: unique symbol;
declare const RAW_GPS_COORD_BRAND: unique symbol;

export type WebMercatorCoord = Vec2 & { readonly [WEB_MERCATOR_COORD_BRAND]: "WebMercatorCoord" };
export type RawGpsCoord = Vec2 & { readonly [RAW_GPS_COORD_BRAND]: "RawGpsCoord" };

export function asWebMercatorCoord(v: Vec2): WebMercatorCoord {
  return v as WebMercatorCoord;
}

export function asRawGpsCoord(v: Vec2): RawGpsCoord {
  return v as RawGpsCoord;
}

const WebMercatorCoordSchema = Vec2Schema.transform<WebMercatorCoord>((v) => asWebMercatorCoord(v));
const RawGpsCoordSchema = Vec2Schema.transform<RawGpsCoord>((v) => asRawGpsCoord(v));

export const TraccarDeviceSchema = z.object({
  id: z.number(),
  name: z.string(),
  lastUpdate: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
});
export type TraccarDevice = z.infer<typeof TraccarDeviceSchema>;

export const SessionSchema = z.object({
  token: z.string(),
  username: z.string(),
  traccarToken: z.string(),
  createdAt: z.number(),
  lastActive: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

export const DevicePointSchema = z.object({
  device: z.number(),
  sourceDeviceId: z.number().nullable(),
  geo: RawGpsCoordSchema,
  mean: WebMercatorCoordSchema,
  timestamp: z.number(),
  accuracy: z.number(),
  anchorStartTimestamp: z.number(),
  confidence: z.number(),
});
export type DevicePoint = z.infer<typeof DevicePointSchema>;

export const RawGpsPositionSchema = z.object({
  device: z.number(),
  geo: RawGpsCoordSchema,
  accuracy: z.number(),
  timestamp: z.number(),
});
export type RawGpsPosition = z.infer<typeof RawGpsPositionSchema>;

export const WebMercatorPositionSchema = z.object({
  device: z.number(),
  geo: WebMercatorCoordSchema,
  accuracy: z.number(),
  timestamp: z.number(),
});
export type WebMercatorPosition = z.infer<typeof WebMercatorPositionSchema>;

export const MotionProfileNameSchema = z.enum(['person', 'car']);
export type MotionProfileName = z.infer<typeof MotionProfileNameSchema>;

const WorldBoundsSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});

export const AppDeviceSchema = z.object({
  id: z.number(),
  name: z.string(),
  emoji: z.string(),
  color: z.string().nullable(),
  lastSeen: z.number().nullable(),
  effectiveMotionProfile: MotionProfileNameSchema,
  motionProfile: MotionProfileNameSchema.nullable(),
  isOwner: z.boolean(),
  memberDeviceIds: z.array(z.number()).nullable(),
});
export type AppDevice = z.infer<typeof AppDeviceSchema>;

const StationaryEventSchema = z.object({
  type: z.literal('stationary'),
  start: z.number(),
  end: z.number(),
  mean: WebMercatorCoordSchema,
  variance: z.number(),
  isDraft: z.boolean(),
});

export const MotionEventSchema = z.object({
  type: z.literal('motion'),
  start: z.number(),
  end: z.number(),
  startAnchor: WebMercatorCoordSchema,
  endAnchor: WebMercatorCoordSchema,
  path: z.array(WebMercatorPositionSchema),
  outliers: z.array(WebMercatorPositionSchema),
  distance: z.number(),
  isDraft: z.boolean(),
  bounds: WorldBoundsSchema,
});
export type MotionEvent = z.infer<typeof MotionEventSchema>;

export const EngineEventSchema = z.union([StationaryEventSchema, MotionEventSchema]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;

// Internal engine types
export const StationaryDraftSchema = z.object({
  type: z.literal('stationary'),
  start: z.number(),
  stationaryStartAnchor: WebMercatorCoordSchema,
  recent: z.array(DevicePointSchema),
  pending: z.array(DevicePointSchema),
});
export type StationaryDraft = z.infer<typeof StationaryDraftSchema>;

export const MotionDraftSchema = z.object({
  type: z.literal('motion'),
  start: z.number(),
  stationaryCutoff: z.number(),
  predecessor: StationaryDraftSchema,
  startAnchor: WebMercatorCoordSchema,
  path: z.array(DevicePointSchema),
  outliers: z.array(DevicePointSchema),
  recent: z.array(DevicePointSchema),
});
export type MotionDraft = z.infer<typeof MotionDraftSchema>;

export const EngineDraftSchema = z.union([StationaryDraftSchema, MotionDraftSchema]);
export type EngineDraft = z.infer<typeof EngineDraftSchema>;

export const EngineStateSchema = z.object({
  draft: EngineDraftSchema.nullable(),
  closed: z.array(EngineEventSchema),
  lastTimestamp: z.number().nullable(),
});
export type EngineState = z.infer<typeof EngineStateSchema>;

export const RawTraccarPositionSchema = z.object({
  deviceId: z.number(),
  fixTime: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number().optional(),
}).loose();

// --- Shared Record Types ---

const EntitiesSchema = z.record(z.string(), AppDeviceSchema);
const ActivePointsByDeviceSchema = z.record(z.string(), z.array(DevicePointSchema));
const EventsByDeviceSchema = z.record(z.string(), z.array(EngineEventSchema));

// --- WebSocket Protocol ---

// Auth payload sent once at connection authentication
const AuthPayloadSchema = z.object({
  ownedDeviceIds: z.array(z.number()),
});

export const InitialStatePayloadSchema = z.object({
  entities: EntitiesSchema,
  activePointsByDevice: ActivePointsByDeviceSchema,
  eventsByDevice: EventsByDeviceSchema,
  maptilerApiKey: z.string(),
});
export type InitialStatePayload = z.infer<typeof InitialStatePayloadSchema>;

export const DeviceShareSchema = z.object({
  deviceId: z.number(),
  deviceName: z.string(),
  sharedWith: z.string(),
  sharedAt: z.number(),
});
export type DeviceShare = z.infer<typeof DeviceShareSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth_success"), payload: AuthPayloadSchema, requestId: z.never().optional() }),
  z.object({ type: z.literal("initial_state"), payload: InitialStatePayloadSchema, requestId: z.never().optional() }),
  z.object({
    type: z.literal("positions_update"),
    payload: z.object({
      activePoints: ActivePointsByDeviceSchema,
      events: EventsByDeviceSchema,
    }),
    requestId: z.never().optional()
  }),
  z.object({
    type: z.literal("config_update"),
    payload: z.object({
      devices: EntitiesSchema,
      groups: z.array(AppDeviceSchema),
      allowedDeviceIds: z.array(z.number()),
      ownedDeviceIds: z.array(z.number())
    }),
    requestId: z.never().optional()
  }),
  z.object({ type: z.literal("update_success"), deviceId: z.number(), requestId: z.string() }),
  z.object({ type: z.literal("create_success"), device: TraccarDeviceSchema, requestId: z.string() }),
  z.object({ type: z.literal("delete_success"), groupId: z.number(), requestId: z.string() }),
  z.object({ type: z.literal("login_success"), token: z.string(), requestId: z.string() }),
  z.object({ type: z.literal("share_success"), deviceId: z.number(), sharedWith: z.string(), requestId: z.string() }),
  z.object({ type: z.literal("unshare_success"), deviceId: z.number(), username: z.string(), requestId: z.string() }),
  z.object({ type: z.literal("shares_list"), payload: z.array(DeviceShareSchema), requestId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string(), requestId: z.string().optional() }),
  z.object({ type: z.literal("ping"), requestId: z.never().optional() }),
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("authenticate"), token: z.string(), requestId: z.never().optional() }),
  z.object({
    type: z.literal("update_device"),
    payload: z.object({
      deviceId: z.number(),
      updates: z.object({
        name: z.string().optional(),
        emoji: z.string().optional(),
        color: z.string().optional(),
        motionProfile: MotionProfileNameSchema.optional()
      })
    }),
    requestId: z.string()
  }),
  z.object({
    type: z.literal("create_group"),
    payload: z.object({
      name: z.string(),
      emoji: z.string(),
      memberDeviceIds: z.array(z.number())
    }),
    requestId: z.string()
  }),
  z.object({ type: z.literal("delete_group"), payload: z.object({ groupId: z.number() }), requestId: z.string() }),
  z.object({
    type: z.literal("add_device_to_group"),
    payload: z.object({ groupId: z.number(), deviceId: z.number() }),
    requestId: z.string()
  }),
  z.object({
    type: z.literal("remove_device_from_group"),
    payload: z.object({ groupId: z.number(), deviceId: z.number() }),
    requestId: z.string()
  }),
  z.object({
    type: z.literal("login"),
    payload: z.object({ username: z.string(), password: z.string() }),
    requestId: z.string()
  }),
  z.object({
    type: z.literal("share_device"),
    payload: z.object({ deviceId: z.number(), username: z.string() }),
    requestId: z.string()
  }),
  z.object({
    type: z.literal("unshare_device"),
    payload: z.object({ deviceId: z.number(), username: z.string() }),
    requestId: z.string()
  }),
  z.object({
    type: z.literal("get_shares"),
    requestId: z.string()
  }),
  z.object({ type: z.literal("pong"), requestId: z.never().optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
