import type { XWebEndpointConfig } from "@/src/integrations/x/types";

const BIRD_WEB_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export const X_DM_WEB_PARAMS = Object.freeze({
  context: "FETCH_DM_CONVERSATION",
  include_profile_interstitial_type: "1",
  include_blocking: "1",
  include_blocked_by: "1",
  include_followed_by: "1",
  include_want_retweets: "1",
  include_mute_edge: "1",
  include_can_dm: "1",
  include_can_media_tag: "1",
  include_ext_has_nft_avatar: "1",
  include_ext_is_blue_verified: "1",
  include_ext_verified_type: "1",
  include_ext_profile_image_shape: "1",
  skip_status: "1",
  dm_secret_conversations_enabled: "false",
  krs_registration_enabled: "true",
  cards_platform: "Web-12",
  include_cards: "1",
  include_ext_alt_text: "true",
  include_ext_limited_action_results: "false",
  include_quote_count: "true",
  include_reply_count: "1",
  tweet_mode: "extended",
  include_ext_views: "true",
  dm_users: "false",
  include_groups: "true",
  include_inbox_timelines: "true",
  include_ext_media_color: "true",
  supports_reactions: "true",
  include_conversation_info: "true",
  ext: "mediaColor,altText,mediaStats,highlightedLabel,hasNftAvatar,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl",
});

export const DEFAULT_X_WEB_ENDPOINTS: XWebEndpointConfig = Object.freeze({
  accountSettingsUrl: "https://x.com/i/api/account/settings.json",
  inboxInitialStateUrl: "https://x.com/i/api/1.1/dm/inbox_initial_state.json",
  conversationUrl: (conversationId: string) =>
    `https://x.com/i/api/1.1/dm/conversation/${encodeURIComponent(conversationId)}.json`,
  bearerToken: BIRD_WEB_BEARER_TOKEN,
  dmParams: X_DM_WEB_PARAMS,
});
