/** Core (`koishi-plugin-yesimbot/kernel`, and the package's main entry, which re-exports it): everything a host composes. */
export { YesImBotCore, type ConversationAccess, type ConversationArchiveRequest, type CoreHost, type CoreService } from "./core.js";

export type { ChatAccount, ConnectorAction, ConnectorActions, SameAccount, WebChatAccount } from "./accounts.js";

export { moduleConfig, type Config } from "./config.js";

export type { CoreEventBus } from "./events.js";

export {
  defineConnector,
  defineExtension,
  type Connector,
  type ConnectorContext,
  type ConnectorSocket,
  type CoreEvents,
  type Extension,
  type ExtensionContext,
  type Undo,
} from "./extension.js";

export type {
  ChannelPlugin,
  ChannelPluginSetupContext,
  ChannelOutputSetupContext,
  ReplyDeliverySetupContext,
  ReplyPart,
  ReplyStickerFrame,
  ReplyStickerView,
  ReplyStickerProvider,
  ReplyStickerLease,
  ReplyStickerTransport,
  ReplyToolsOptions,
  ReplyToolSet,
  ImagePreviewCapability,
  ImagePreviewFrame,
  ImagePreviewRequest,
  ImageDescribeRequest,
  MainAgentRoleProfile,
  MainAgentRoleProvider,
  WillBatchDecision,
  WillDebug,
  WillEngine,
  WillPlugin,
  WillReservationOutcome,
  WillState,
} from "./agents/index.js";

export { extractProtectedTokens } from "./agents/index.js";

export { withAbortSignal } from "./abort.js";

export { normalizeReplyParts, validateReplyParts, createReplyTools, ReplyCoordinator, REPLY_MAX_PHASE_BYTES, REPLY_MAX_UNITS } from "./agents/index.js";

export { replyPlatformIds } from "./conversations/reply-receipt.js";

export type { ChannelContext, ChannelKey } from "./channels/index.js";

export { listSessionFiles, readChannelManifestFile, readFileTailLines, readSessionPage } from "./conversations/session-files.js";

export type {
  ChannelManifestSummary,
  JsonlLine,
  SessionFileInfo,
  SessionPage,
  SessionPageProjection,
  SessionPageRequest,
} from "./conversations/session-files.js";

export { deriveChannelKey } from "./channels/index.js";

export { createToolAccessHooks, extractToolAccessActorIds, isToolAccessAllowed, isToolAccessPotentiallyAllowed } from "./tool-access.js";

export type { ToolAccessDecision, ToolAccessRule } from "./tool-access.js";

export type { ConversationReadOptions } from "./conversations/index.js";

export type { MessageBatchController, MessageBatchInput, MessageBatchPlugin, MessageBatchSetupExtensions } from "./message-batches/index.js";

export * from "./messages/index.js";

export type { ContextRegionReview, ContextRegionReviewer, ContextRegionReviewInput, ContextRegionReviewTool } from "./runtimes/region-review.js";

export type { Inbound, PostResult, WhisperResult } from "./messengers/index.js";

export type { PromptPreview, PromptSegment, PromptSegmentSource } from "./runtimes/prompt.js";

export type * from "./models/index.js";

export {
  getSupportedThinkingLevels,
  imageTransportError,
  imageTransportFailure,
  MODEL_ERRORS,
  resolveThinkingLevel,
  THINKING_LEVELS,
  type ImageTransportCode,
} from "./models/index.js";

export { hasCompletedImageRead } from "./agents/image-read-evidence.js";

export { RESOURCE_ERRORS, RESOURCE_MAX_BYTES, resourceError, resourceErrorCode, type ResourceReadErrorCode } from "./resources/index.js";

export { fetchPlatformMedia } from "./resources/platform-media.js";

export { MEDIA_ERRORS, type MediaFetcher } from "./resources/input.js";

export { isPublicAddress } from "@yesimbot/foundation";

export { errorUserText } from "./errors.js";

export { assertPublicHost } from "./resources/remote-image.js";

export { firstFrameToPng, isStillConvertible, stillImageToPng, type StillConvertible, type StillImageType } from "./resources/image-transcode.js";

export type * from "./resources/index.js";

export { Devices, RuntimeIdentity, type DeviceTransport, type ScreenSource, type WorkspaceComputerSwitch, type WorkspaceSwitchControl } from "./devices.js";

export type { ChannelOverride } from "./overrides.js";

export { isAssetId, partElement, partsFromElements, partsMarkup, partsPlainText, textPart } from "@yesimbot/contracts/parts";
export { PLATFORMS, type PlatformDefinition } from "@yesimbot/contracts/platforms";

export type {
  ChoicesPart,
  FilePart,
  ImagePart,
  MentionPart,
  Part,
  PartElement,
  PlatformPart,
  QuotePart,
  TextPart,
  VideoPart,
  WorkspaceFilePart,
} from "@yesimbot/contracts/parts";

export { thinkingLevelMapConfig } from "./config-forms.js";

export {
  capabilityBoundary,
  declareBuiltinTools,
  createToolPolicyHooks,
  guardToolPolicy,
  hasAllowedTools,
  protectPluginTools,
  toolActors,
  toolAllowed,
  type ToolDescriptor,
  type ToolCapability,
} from "./tool-policy.js";

export { modelFetch } from "@yesimbot/foundation";

export type { TaskRecord, TaskKind, TaskStatus } from "./tasks/store.js";

export type { TaskSource } from "./tasks/source.js";

export { taskSourceMatchesScope } from "./tasks/source.js";

export { toolResult, workValue, type WorkStep } from "./tasks/steps.js";
