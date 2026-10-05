// MODEL -> the object graph x-web's GraphQL queries are resolved against
// (runtime/resolver.js walks each query's AST over it).
//
// MODEL is plain data (see data/fixtures.js for the shape; live mode builds
// the same from the classic app's responses). Field names here follow X's
// GraphQL schema as x-web queries it (learned from the captured ASTs with
// tools/ast-fields.js). Only data lives here: which fields a screen reads is
// decided by x-web's own queries, so a field missing here comes back null and
// is listed in XWH_RT.misses.
(function (g) {
  'use strict';

  const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s).toString('base64'));

  function classicDate(ms) {
    const s = new Date(ms).toUTCString(); // "Tue, 06 Oct 2026 11:23:00 GMT"
    const [wd, dd, mon, yyyy, time] = s.replace(',', '').split(' ');
    return wd + ' ' + mon + ' ' + dd + ' ' + time + ' +0000 ' + yyyy;
  }

  const ICON = { like: 'heart_icon', retweet: 'retweet_icon', follow: 'person_icon', reply: 'reply_icon', mention: 'bird_icon', quote: 'retweet_icon' };
  const VERB = { like: 'liked your post', retweet: 'reposted your post', follow: 'followed you', quote: 'quoted your post' };

  function build(model) {
    const users = {};
    const tweets = {};
    const viewerId = model.viewerId;
    const lists = model.lists || {};
    const listsOf = (id) => Object.assign({}, lists, (model.userLists && model.userLists[id]) || {});

    // ---------------------------------------------------------------- users
    function userResults(id) {
      const u = user(id);
      return u ? { __typename: 'UserResults', id: b64('UserResults:' + id), rest_id: id, result: u } : null;
    }

    function user(id) {
      if (id == null) return null;
      if (users[id]) return users[id];
      const u = model.users[id];
      if (!u) return null;
      const verifiedType = u.verified === 'business' ? 'Business' : u.verified === 'government' ? 'Government' : null;
      const urlEnt = u.url ? { urls: [{ url: u.url, expanded_url: u.url, display_url: u.url.replace(/^https?:\/\//, ''), indices: [0, u.url.length] }], hashtags: [], symbols: [], user_mentions: [] } : null;
      const descEnt = { urls: [], hashtags: [], symbols: [], user_mentions: [] };
      const o = users[id] = {
        __typename: 'User',
        __implements: ['Node'],
        id: b64('User:' + id),
        rest_id: id,
        is_blue_verified: u.verified === 'blue',
        verification: { __typename: 'UserVerification', verified: Boolean(verifiedType), verified_type: verifiedType, is_blue_verified: u.verified === 'blue', is_identity_verified: false },
        core: { __typename: 'UserCore', name: u.name, screen_name: u.screenName, created_at: classicDate(u.createdAt), created_at_ms: u.createdAt },
        avatar: { __typename: 'UserAvatar', image_url: u.avatar },
        banner: u.banner ? { __typename: 'UserBanner', image_url: u.banner } : null,
        location: { __typename: 'UserLocation', location: u.location || '' },
        privacy: { __typename: 'UserPrivacy', protected: u.protected },
        profile_bio: { __typename: 'UserBio', description: u.bio, entities: { __typename: 'UserEntities', description: descEnt, url: urlEnt } },
        relationship_perspectives: {
          __typename: 'UserRelationshipPerspectives',
          following: u.following, followed_by: u.followedBy, blocking: u.blocking, blocked_by: false,
          muting: u.muting, follow_request_sent: u.followRequestSent, notifications: false,
          dm_blocking: false, dm_blocked_by: false,
        },
        relationship_counts: { __typename: 'UserRelationshipCounts', followers: u.followersCount, following: u.followingCount },
        tweet_counts: { __typename: 'UserTweetCounts', tweets: u.tweetsCount, media_tweets: 0 },
        is_following: u.following,
        is_followed_by: u.followedBy,
        follow_request_sent: u.followRequestSent,
        super_following: false,
        super_followed_by: false,
        super_follow_eligible: false,
        identity_profile_labels_highlighted_label: null,
        affiliates_highlighted_label: null,
        profile_translation: null,
        grok_translated_bio_with_availability: null,
        creator_subscriptions_count: 0,
        subscribers_count: 0,
        has_hidden_subscriptions_on_profile: false,
        profile_image_shape: verifiedType === 'Business' ? 'Square' : 'Circle',
        possibly_sensitive: false,
        can_view_expanded_profile: !u.protected || u.following || id === viewerId,
        business_account: null,
        professional: null,
        highlights_info: null,
        profilemodules: null,
        user_seed_tweet_count: 0,
        legacy_extended_profile: null,
        legacy: {
          __typename: 'ApiUser',
          name: u.name, screen_name: u.screenName, description: u.bio, location: u.location || '',
          created_at: classicDate(u.createdAt),
          followers_count: u.followersCount, friends_count: u.followingCount, statuses_count: u.tweetsCount,
          media_count: 0, favourites_count: 0, listed_count: 0,
          profile_image_url_https: u.avatar, profile_banner_url: u.banner || null,
          protected: u.protected, verified: false, notifications: false, withheld_in_countries: [],
          following: u.following, followed_by: u.followedBy, blocking: u.blocking, muting: u.muting,
          follow_request_sent: u.followRequestSent, default_profile_image: false,
          url: u.url || null,
          entities: { __typename: 'UserEntities', description: descEnt, url: urlEnt },
        },
      };
      // connection timelines (Following / Followers / profile posts)
      const L = listsOf(id);
      o.following_timeline = { __typename: 'Timeline', id: b64('FollowingTimeline:' + id), timeline: conn('following-' + id, L.following, userEntry) };
      o.followers_timeline = { __typename: 'Timeline', id: b64('FollowersTimeline:' + id), timeline: conn('followers-' + id, L.followers, userEntry) };
      o.blue_verified_followers_timeline = { __typename: 'Timeline', id: b64('VerifiedFollowersTimeline:' + id), timeline: conn('vfollowers-' + id, L.verifiedFollowers, userEntry) };
      o.verified_followers_timeline = o.blue_verified_followers_timeline;
      o.profile_user_originals_timeline = { __typename: 'Timeline', id: b64('Originals:' + id), timeline: conn('posts-' + id, L.profilePosts, tweetEntry) };
      if (id === viewerId) {
        o.notification_timeline = () => ({ __typename: 'Timeline', id: b64('Notifications:' + id), timeline: conn('notifications', model.notifications, notificationEntry) });
      }
      return o;
    }

    function userBySn(sn) {
      const u = Object.values(model.users).find((x) => x.screenName.toLowerCase() === String(sn || '').toLowerCase());
      return u ? u.id : null;
    }

    // ---------------------------------------------------------------- tweets
    function tweetObject(t, key) {
      const author = userResults(t.authorId);
      const media = (t.media || []).map((m, i) => ({
        __typename: 'ApiMediaEntity',
        id_str: t.id + '0' + i, type: 'photo', media_url_https: m.url,
        expanded_url: 'https://x.com/' + (model.users[t.authorId] || {}).screenName + '/status/' + t.id + '/photo/' + (i + 1),
        indices: [t.text.length, t.text.length],
        original_info: { __typename: 'ApiMediaEntityOriginalInfo', width: m.width, height: m.height },
        ext_media_availability: { __typename: 'ApiMediaAvailability', status: 'Available', reason: null },
        ext_alt_text: null, sensitive_media_warning: null, features: null, allow_download_status: null,
        possibly_sensitive: false, source_status_id_str: null, source_user_results: null, video_info: null,
        additional_media_info: null, ext_playlists: null,
      }));
      return {
        __typename: 'Tweet',
        __implements: ['Node'],
        id: b64('Tweet:' + key),
        rest_id: t.id,
        core: { __typename: 'TweetCore', user_results: author },
        details: {
          __typename: 'TBirdData',
          full_text: t.text, created_at_ms: t.createdAt,
          display_text_range: [0, t.text.length],
          hashtag_entities: [], cashtag_entities: [], smarttags: [], timestamp_entities: [],
          conversation_control: null, self_thread_metadata: null,
        },
        counts: { __typename: 'ApiCounts', reply_count: t.replyCount, retweet_count: t.retweetCount, favorite_count: t.likeCount, quote_count: 0, bookmark_count: t.bookmarkCount },
        perspective: { __typename: 'StatusPerspective', favorited: t.liked, retweeted: t.retweeted, bookmarked: t.bookmarked },
        views: { __typename: 'ViewCountInfo', count: t.viewCount == null ? null : String(t.viewCount) },
        url_entities: [], mention_entities: [],
        media_entities2: media,
        quoted_tweet_results: t.quotedId ? tweetResults(t.quotedId) : null,
        reply_to_results: null,
        reply_to_user_results: t.replyToScreenName ? userResults(userBySn(t.replyToScreenName)) : null,
        legacy: { __typename: 'LegacyTweet', lang: 'en', possibly_sensitive: false, retweeted_status_results: null },
        edit_control: null, note_tweet: null, place: null, card: null, article: null, community_results: null,
        birdwatch_pivot: null, exclusive_tweet_info: null, trusted_friends_info_result: null,
        super_follows_conversation_user_results: null, jetfuel_attachment: null, reaction_context: null,
        grok_translated_post_with_availability: null, content_disclosure: null, quick_promote_eligibility: null,
        cashtag_attachments: [], conversation_muted: false, is_translatable: false,
      };
    }

    // A repost is the reposter's wrapper tweet whose legacy.retweeted_status_results is the original.
    function tweet(key) {
      if (key == null) return null;
      if (tweets[key]) return tweets[key];
      const t = model.tweets[key];
      if (!t) return null;
      if (t.retweetedById) {
        const origKey = key + ':orig';
        tweets[origKey] = tweetObject(Object.assign({}, t, { retweetedById: null }), origKey);
        const w = tweetObject(Object.assign({}, t, { authorId: t.retweetedById, id: '8' + t.id.slice(1), text: 'RT', media: [], quotedId: null, replyToScreenName: null }), key);
        w.legacy.retweeted_status_results = { __typename: 'TweetResults', id: b64('TweetResults:' + origKey), rest_id: t.id, result: tweets[origKey] };
        tweets[key] = w;
        return w;
      }
      tweets[key] = tweetObject(t, key);
      return tweets[key];
    }

    function tweetResults(key) {
      const t = tweet(key);
      return t ? { __typename: 'TweetResults', id: b64('TweetResults:' + key), rest_id: t.rest_id, result: t } : null;
    }

    // ---------------------------------------------------------------- URT
    let seq = 0;
    const sortIndex = () => String(1e12 - (++seq));
    function item(content, extra) {
      return Object.assign({ __typename: 'TimelineTimelineItem', client_event_info: null, feedback_info: null, content }, extra || {});
    }
    function userContent(id) {
      return { __typename: 'TimelineUser', display_type: 'User', user_results: userResults(id), social_context: null, promoted_metadata: null };
    }
    function tweetContent(key) {
      return { __typename: 'TimelineTweet', display_type: 'Tweet', tweet_results: tweetResults(key), social_context: pinContext(key), promoted_metadata: null, has_moderated_replies: false, tweet_facepile: null };
    }
    function pinContext(key) {
      const t = model.tweets[key];
      return t && t.pinned ? { __typename: 'TimelineGeneralContext', context_type: 'Pin', text: 'Pinned', landing_url: null } : null;
    }
    function userEntry(id) {
      return { entry_id: 'user-' + id, sort_index: sortIndex(), content: item(userContent(id)) };
    }
    function tweetEntry(key) {
      const t = model.tweets[key];
      return { entry_id: 'tweet-' + (t ? t.id : key), sort_index: sortIndex(), content: item(tweetContent(key)) };
    }
    function moduleEntry(entryId, items, extra) {
      return {
        entry_id: entryId, sort_index: sortIndex(),
        content: Object.assign({
          __typename: 'TimelineTimelineModule',
          display_type: 'Vertical', header: null, footer: null, client_event_info: null, metadata: null,
          items: items.map((it) => ({ __typename: 'TimelineModuleItem', entry_id: entryId + '-' + it.id, item: item(it.content) })),
        }, extra || {}),
      };
    }
    function conversationEntry(key) {
      const t = model.tweets[key];
      return moduleEntry('conversationthread-' + t.id, [{ id: 'tweet-' + t.id, content: tweetContent(key) }], {
        display_type: 'VerticalConversation',
        metadata: { __typename: 'TimelineModuleMetadata', conversation_metadata: { __typename: 'TimelineModuleConversationMetadata', all_tweet_ids: [t.id], enable_deduplication: true } },
      });
    }
    function whoToFollowEntry(ids) {
      return moduleEntry('who-to-follow-xwh', ids.map((id) => ({ id: 'user-' + id, content: userContent(id) })), {
        header: { __typename: 'TimelineModuleHeader', text: 'Who to follow', sticky: false, display_type: 'Classic', social_context: null, landing_url: null },
        footer: { __typename: 'TimelineModuleFooter', text: 'Show more', landing_url: { __typename: 'TimelineUrl', url: '/i/connect_people', url_type: 'DeepLink' } },
      });
    }
    function notificationEntry(n) {
      if (n.type === 'reply' || n.type === 'mention') return tweetEntry(n.tweetId);
      const names = n.userIds.map((id) => model.users[id]).filter(Boolean);
      const first = names[0] ? names[0].name : 'Someone';
      const text = first + (names.length > 1 ? ' and ' + (names.length - 1) + ' other' + (names.length > 2 ? 's' : '') : '') + ' ' + (VERB[n.type] || 'interacted');
      return {
        entry_id: 'notification-' + n.id, sort_index: sortIndex(),
        content: item({
          __typename: 'TimelineNotification',
          id: b64('Notification:' + n.id),
          icon: ICON[n.type] || 'bird_icon',
          timestamp_ms: String(n.createdAt),
          message: { __typename: 'TimelineNotificationLocalizedText', text },
          rich_message: {
            __typename: 'TimelineRichText', text, rtl: false, alignment: null,
            entities: names[0] ? [{ __typename: 'TimelineRichTextEntity', from_index: 0, to_index: first.length, format: 'Strong', ref: { __typename: 'TimelineRichTextUser', user_results: userResults(names[0].id) } }] : [],
          },
          url: { __typename: 'TimelineUrl', url: n.tweetId ? '/' + (model.users[viewerId] || {}).screenName + '/status/' + model.tweets[n.tweetId].id : '/' + (names[0] || {}).screenName, url_type: 'DeepLink' },
          social_context: null,
          template: {
            __typename: 'TimelineNotificationAggregateUserActions',
            from_users: n.userIds.map((id) => ({ __typename: 'TimelineNotificationUserRef', id_results: userResults(id) })),
            target_objects: n.tweetId ? [{ __typename: 'TimelineNotificationTweetRef', id_results: tweetResults(n.tweetId) }] : [],
            additional_context: null, show_all_link_text: null,
          },
        }),
      };
    }
    function cursorEntry(kind) {
      return {
        entry_id: 'cursor-' + kind + '-xwh', sort_index: sortIndex(),
        content: { __typename: 'TimelineTimelineCursor', value: 'xwh-cursor-' + kind, cursor_type: kind === 'top' ? 'Top' : 'Bottom', stop_on_empty_response: true, display_treatment: null },
      };
    }
    // First page (cursor null): clear + entries + cursors. Later pages add
    // nothing and terminate the timeline, so x-web stops paginating.
    function timeline(id, entries, cursor) {
      const first = cursor == null;
      return {
        __typename: 'TimelineTimeline',
        id: 'xwh-timeline-' + id,
        instructions: first
          ? [
            { __typename: 'TimelineClearCache', retain_viewport_items: false },
            { __typename: 'TimelineAddEntries', entries: entries.concat([cursorEntry('top'), cursorEntry('bottom')]) },
          ]
          : [
            { __typename: 'TimelineAddEntries', entries: [] },
            { __typename: 'TimelineTerminateTimeline', direction: 'Bottom' },
          ],
        metadata: null,
        response_objects: null,
      };
    }
    // A (count, cursor) connection serving `list` once.
    function conn(name, list, toEntry) {
      return (args) => timeline(name, args.cursor == null ? (list || []).map(toEntry).filter(Boolean) : [], args.cursor);
    }

    // ---------------------------------------------------------------- root
    const viewerUser = viewerId ? userResults(viewerId) : null;
    const root = {
      __typename: 'Query',
      user_result_by_screen_name: ({ screen_name }) => userResults(userBySn(screen_name)),
      user_result_by_rest_id: ({ rest_id }) => userResults(rest_id),
      user_results_by_rest_ids: ({ rest_ids }) => (rest_ids || []).map(userResults),
      tweet_result_by_rest_id: ({ rest_id }) => tweetResults(Object.keys(model.tweets).find((k) => model.tweets[k].id === rest_id && !model.tweets[k].retweetedById) || rest_id),
      threaded_conversation_with_injections_v2: ({ focal_tweet_id, cursor }) => {
        if (cursor != null) return timeline('conversation-' + focal_tweet_id, [], cursor);
        const focalKey = Object.keys(model.tweets).find((k) => model.tweets[k].id === focal_tweet_id);
        const focal = tweetEntry(focalKey); // first: highest sort index, replies sort below it
        return timeline('conversation-' + focal_tweet_id, [focal].concat((lists.conversation || []).map(conversationEntry)), cursor);
      },
      home_timeline: { __typename: 'Timeline', id: b64('Home'), home_timeline_urt: conn('home', lists.home, tweetEntry), home_latest_timeline_urt: conn('home-latest', lists.home, tweetEntry) },
      search_by_raw_query: ({ raw_query }) => ({
        __typename: 'SearchQuery', id: b64('Search:' + raw_query),
        timeline: ({ product }) => ({
          __typename: 'Timeline', id: b64('SearchTimeline:' + raw_query + ':' + product),
          timeline: product === 'People'
            ? conn('search-people', lists.searchPeople, userEntry)
            : conn('search-' + product, lists.searchTop, tweetEntry),
        }),
      }),
      viewer_v2: viewerId ? {
        __typename: 'Viewer',
        user_results: viewerUser,
        blocking_timeline: { __typename: 'Timeline', id: b64('Blocking'), timeline: conn('blocked', lists.blocked, userEntry) },
        muting_timeline: { __typename: 'Timeline', id: b64('Muting'), timeline: conn('muted', lists.muted, userEntry) },
      } : null,
      viewer: viewerId ? { __typename: 'Viewer', user_results: viewerUser, claims: null, is_active_creator: false } : null,
      connect_tab_timeline: { __typename: 'Timeline', id: b64('Connect'), timeline: conn('connect', lists.whoToFollow, userEntry) },
      // logged-in right sidebar: a "Who to follow" module
      explore_sidebar: { __typename: 'Timeline', id: b64('ExploreSidebar'), timeline: (args) => timeline('sidebar', args.cursor == null && viewerId && lists.whoToFollow ? [whoToFollowEntry(lists.whoToFollow)] : [], args.cursor) },
      pinned_timelines: { __typename: 'PinnedTimelines', pinned_timelines: [] },
      can_access_payments: false,
      xpayments_enrolled: false,
    };
    return { root, user, tweet, userResults, tweetResults, timeline, conn, userEntry, tweetEntry };
  }

  // The viewer object x-web's ViewerProvider takes (see xweb/entry.js)
  function viewerOf(model) {
    const u = model.viewerId && model.users[model.viewerId];
    if (!u) return null;
    return {
      userId: u.id, name: u.name, screenName: u.screenName,
      friendsCount: u.followingCount, followersCount: u.followersCount,
      isProtected: u.protected, isActiveCreator: false,
    };
  }

  const api = { build, classicDate, viewerOf };
  g.XWH_GRAPH = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
