import { z } from "zod";

export const Vec2Schema = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2Schema>;

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
  geo: Vec2Schema,
  mean: Vec2Schema,
  timestamp: z.number(),
  accuracy: z.number(),
  anchorStartTimestamp: z.number(),
  confidence: z.number(),
});
export type DevicePoint = z.infer<typeof DevicePointSchema>;

export const NormalizedPositionSchema = z.object({
  device: z.number(),
  geo: Vec2Schema,
  accuracy: z.number(),
  timestamp: z.number(),
});
export type NormalizedPosition = z.infer<typeof NormalizedPositionSchema>;

export const MotionProfileNameSchema = z.enum(['person', 'car']);
export type MotionProfileName = z.infer<typeof MotionProfileNameSchema>;

export const WorldBoundsSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});
export type WorldBounds = z.infer<typeof WorldBoundsSchema>;

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

export const StationaryEventSchema = z.object({
  type: z.literal('stationary'),
  start: z.number(),
  end: z.number(),
  mean: Vec2Schema,
  variance: z.number(),
  isDraft: z.boolean(),
});
export type StationaryEvent = z.infer<typeof StationaryEventSchema>;

export const MotionPathPointSchema = NormalizedPositionSchema;
export type MotionPathPoint = z.infer<typeof MotionPathPointSchema>;

export const MotionEventSchema = z.object({
  type: z.literal('motion'),
  start: z.number(),
  end: z.number(),
  startAnchor: Vec2Schema,
  endAnchor: Vec2Schema,
  path: z.array(MotionPathPointSchema),
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
  stationaryStartAnchor: Vec2Schema,
  recent: z.array(DevicePointSchema),
  pending: z.array(DevicePointSchema),
});
export type StationaryDraft = z.infer<typeof StationaryDraftSchema>;

export const MotionDraftSchema = z.object({
  type: z.literal('motion'),
  start: z.number(),
  stationaryCutoff: z.number(),
  predecessor: StationaryDraftSchema,
  startAnchor: Vec2Schema,
  path: z.array(DevicePointSchema),
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
export type RawTraccarPosition = z.infer<typeof RawTraccarPositionSchema>;

// --- Shared Record Types ---

export const EntitiesSchema = z.record(z.string(), AppDeviceSchema);
export type Entities = z.infer<typeof EntitiesSchema>;

export const ActivePointsByDeviceSchema = z.record(z.string(), z.array(DevicePointSchema));
export type ActivePointsByDevice = z.infer<typeof ActivePointsByDeviceSchema>;

export const EventsByDeviceSchema = z.record(z.string(), z.array(EngineEventSchema));
export type EventsByDevice = z.infer<typeof EventsByDeviceSchema>;

// --- WebSocket Protocol ---

export const InitialStatePayloadSchema = z.object({
  entities: EntitiesSchema,
  activePointsByDevice: ActivePointsByDeviceSchema,
  eventsByDevice: EventsByDeviceSchema,
  maptilerApiKey: z.string(),
  metadata: z.object({
    rootIds: z.array(z.number()),
  }),
});
export type InitialStatePayload = z.infer<typeof InitialStatePayloadSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
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
      devices: EntitiesSchema.nullable(),
      groups: z.array(AppDeviceSchema).nullable()
    }),
    requestId: z.never().optional()
  }),
  z.object({ type: z.literal("update_success"), deviceId: z.number(), requestId: z.string().optional() }),
  z.object({ type: z.literal("create_success"), device: TraccarDeviceSchema, requestId: z.string().optional() }),
  z.object({ type: z.literal("delete_success"), groupId: z.number(), requestId: z.string().optional() }),
  z.object({ type: z.literal("error"), message: z.string(), requestId: z.string().optional() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("authenticate"), token: z.string() }),
  z.object({
    type: z.literal("update_device"),
    payload: z.object({
      deviceId: z.number(),
      updates: z.object({
        name: z.string().optional(),
        emoji: z.string().optional(),
        color: z.string().nullable().optional(),
        motionProfile: z.string().nullable().optional()
      })
    }),
    requestId: z.string().optional()
  }),
  z.object({
    type: z.literal("create_group"),
    payload: z.object({
      name: z.string(),
      emoji: z.string(),
      memberDeviceIds: z.array(z.number())
    }),
    requestId: z.string().optional()
  }),
  z.object({ type: z.literal("delete_group"), payload: z.object({ groupId: z.number() }), requestId: z.string().optional() }),
  z.object({
    type: z.literal("add_device_to_group"),
    payload: z.object({ groupId: z.number(), deviceId: z.number() }),
    requestId: z.string().optional()
  }),
  z.object({
    type: z.literal("remove_device_from_group"),
    payload: z.object({ groupId: z.number(), deviceId: z.number() }),
    requestId: z.string().optional()
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
