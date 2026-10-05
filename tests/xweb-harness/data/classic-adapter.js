// Classic web app GraphQL responses -> harness MODEL (see view/core.js).
//
// Live mode fetches the same GraphQL operations the classic x.com app uses
// (Following, Followers, UserTweets, TweetDetail, SearchTimeline, HomeTimeline,
// NotificationsTimeline, BlockedAccountsAll, MutedAccounts ...) and feeds the
// JSON through here. The walk is generic: it finds every `instructions` array
// and reads the entries in order, so it does not care where an operation puts
// its timeline (data.user.result.timeline..., data.home.home_timeline_urt...).
// Both the older user shape (legacy.screen_name) and the newer one
// (core.screen_name, avatar.image_url, relationship_perspectives) are read.
(function (g) {
  'use strict';
  const X = g.XWH = g.XWH || {};

  function parseDate(s) {
    if (!s) return 0;
    const t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }

  function unwrapTweet(r) {
    if (!r) return null;
    if (r.__typename === 'TweetWithVisibilityResults' && r.tweet) return r.tweet;
    if (r.tweet && !r.legacy) return r.tweet;
    return r.legacy ? r : null;
  }

  function readUser(model, r) {
    if (!r || (r.__typename && r.__typename !== 'User')) return null;
    const L = r.legacy || {};
    const core = r.core || {};
    const rel = r.relationship_perspectives || {};
    const id = r.rest_id || L.id_str;
    if (!id) return null;
    const screenName = core.screen_name || L.screen_name;
    if (!screenName) return null;
    const verifiedType = (r.verification && r.verification.verified_type) || L.verified_type;
    let verified = null;
    if (verifiedType === 'Business') verified = 'business';
    else if (verifiedType === 'Government') verified = 'government';
    else if (r.is_blue_verified || L.verified) verified = 'blue';
    const pick = (a, b) => (a !== undefined ? a : b);
    const u = {
      id,
      screenName,
      name: core.name || L.name || screenName,
      avatar: (r.avatar && r.avatar.image_url) || L.profile_image_url_https || '',
      banner: L.profile_banner_url ? L.profile_banner_url + '/1500x500' : null,
      bio: (r.profile_bio && r.profile_bio.description) || L.description || '',
      location: (r.location && r.location.location) || L.location || null,
      url: L.entities && L.entities.url && L.entities.url.urls && L.entities.url.urls[0]
        ? (L.entities.url.urls[0].expanded_url || L.url) : (L.url || null),
      createdAt: parseDate(core.created_at || L.created_at),
      followersCount: L.followers_count || 0,
      followingCount: L.friends_count || 0,
      tweetsCount: L.statuses_count || 0,
      verified,
      protected: Boolean(pick(r.privacy && r.privacy.protected, L.protected)),
      following: Boolean(pick(rel.following, L.following)),
      followedBy: Boolean(pick(rel.followed_by, L.followed_by)),
      followRequestSent: Boolean(pick(rel.follow_request_sent, L.follow_request_sent)),
      blocking: Boolean(pick(rel.blocking, L.blocking)),
      muting: Boolean(pick(rel.muting, L.muting)),
    };
    // Don't let a sparse copy (e.g. inside a notification) erase a fuller one
    const prev = model.users[id];
    model.users[id] = prev ? Object.assign({}, prev, u) : u;
    return id;
  }

  function readTweet(model, raw) {
    const r = unwrapTweet(raw);
    if (!r) return null;
    const L = r.legacy || {};
    const id = r.rest_id || L.id_str;
    if (!id) return null;
    const authorRes = r.core && r.core.user_results && r.core.user_results.result;
    const authorId = readUser(model, authorRes) || L.user_id_str;

    // A classic "retweet" is a wrapper tweet whose legacy.retweeted_status_result is the original.
    const rtRaw = L.retweeted_status_result && L.retweeted_status_result.result;
    if (rtRaw) {
      const origId = readTweet(model, rtRaw);
      if (origId) {
        // Keyed by the wrapper, but the object keeps the original's id so
        // links point at /<author>/status/<original> as x-web renders them.
        const key = 'rt-' + id;
        model.tweets[key] = Object.assign({}, model.tweets[origId], { retweetedById: authorId, repostId: id });
        return key;
      }
    }

    let quotedId = null;
    const q = r.quoted_status_result && r.quoted_status_result.result;
    if (q) quotedId = readTweet(model, q);
    else if (L.quoted_status_id_str && model.tweets[L.quoted_status_id_str]) quotedId = L.quoted_status_id_str;

    const note = r.note_tweet && r.note_tweet.note_tweet_results && r.note_tweet.note_tweet_results.result;
    let text = (note && note.text) || L.full_text || '';
    const media = ((L.extended_entities && L.extended_entities.media) || (L.entities && L.entities.media) || [])
      .filter((m) => m.type === 'photo' || m.type === 'video' || m.type === 'animated_gif')
      .map((m) => ({
        type: 'photo',
        url: m.media_url_https,
        width: (m.original_info && m.original_info.width) || 1200,
        height: (m.original_info && m.original_info.height) || 675,
      }));
    // Strip the trailing t.co link classic appends for media / quotes
    if (media.length || quotedId) text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '');

    model.tweets[id] = {
      id, authorId, text,
      createdAt: parseDate(L.created_at),
      replyCount: L.reply_count || 0,
      retweetCount: (L.retweet_count || 0) + (L.quote_count || 0),
      likeCount: L.favorite_count || 0,
      bookmarkCount: L.bookmark_count || 0,
      viewCount: r.views && r.views.count ? Number(r.views.count) : null,
      liked: Boolean(L.favorited), retweeted: Boolean(L.retweeted), bookmarked: Boolean(L.bookmarked),
      quotedId,
      retweetedById: null,
      replyToScreenName: L.in_reply_to_screen_name || null,
      pinned: false,
      media,
    };
    return id;
  }

  const ICON_TYPE = {
    heart_icon: 'like', retweet_icon: 'retweet', person_icon: 'follow',
    reply_icon: 'reply', bird_icon: 'mention',
  };

  function iconType(name) {
    const n = name.toLowerCase();
    if (/heart|like/.test(n)) return 'like';
    if (/retweet|repost/.test(n)) return 'retweet';
    if (/person|follow/.test(n)) return 'follow';
    if (/reply/.test(n)) return 'reply';
    return 'mention';
  }

  function readItemContent(model, ic, out, entryId) {
    if (!ic) return;
    const type = ic.itemType || ic.__typename;
    if (type === 'TimelineTweet') {
      const id = readTweet(model, ic.tweet_results && ic.tweet_results.result);
      if (id) {
        if (ic.socialContext && ic.socialContext.contextType === 'Pin') model.tweets[id].pinned = true;
        out.tweetIds.push(id);
      }
    } else if (type === 'TimelineUser') {
      const id = readUser(model, ic.user_results && ic.user_results.result);
      if (id) out.userIds.push(id);
    } else if (type === 'TimelineNotification') {
      // camelCase (REST-era) and snake_case (GraphQL) spellings both seen
      const tpl = (ic.template && (ic.template.aggregateUserActionsV1 || ic.template.aggregate_user_actions_v1 || ic.template)) || {};
      const from = tpl.fromUsers || tpl.from_users || [];
      const targets = tpl.targetObjects || tpl.target_objects || [];
      const userIds = from.map((f) => readUser(model, f.user_results && f.user_results.result)).filter(Boolean);
      const target = targets[0];
      const tweetId = target ? readTweet(model, target.tweet_results && target.tweet_results.result) : null;
      const iconName = String(ic.notification_icon || '');
      out.notifications.push({
        id: ic.id || entryId,
        type: ICON_TYPE[iconName] || iconType(iconName),
        userIds, tweetId,
        createdAt: Number(ic.timestamp_ms) || 0,
        text: ic.rich_message && ic.rich_message.text,
      });
    }
  }

  function readEntry(model, entry, out) {
    const c = entry && entry.content;
    if (!c) return;
    const t = c.entryType || c.__typename;
    if (t === 'TimelineTimelineItem') {
      const before = out.tweetIds.length;
      readItemContent(model, c.itemContent, out, entry.entryId);
      // Mentions/replies on the notifications timeline are plain tweet items
      if (out.isNotifications && out.tweetIds.length > before) {
        const id = out.tweetIds[out.tweetIds.length - 1];
        const tw = model.tweets[id];
        out.notifications.push({ id: entry.entryId, type: tw.replyToScreenName ? 'reply' : 'mention', userIds: [tw.authorId], tweetId: id, createdAt: tw.createdAt });
      }
    } else if (t === 'TimelineTimelineModule') {
      const ids = [];
      (c.items || []).forEach((it) => {
        const sub = { tweetIds: [], userIds: [], notifications: [] };
        readItemContent(model, it.item && it.item.itemContent, sub, it.entryId);
        ids.push(...sub.tweetIds);
        out.userIds.push(...sub.userIds);
      });
      // A conversation module (thread) reads like consecutive tweets
      out.tweetIds.push(...ids);
    }
  }

  function findInstructions(node, acc) {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) { node.forEach((n) => findInstructions(n, acc)); return acc; }
    if (Array.isArray(node.instructions)) acc.push(node.instructions);
    for (const k of Object.keys(node)) {
      if (k === 'instructions') continue;
      const v = node[k];
      if (v && typeof v === 'object') findInstructions(v, acc);
    }
    return acc;
  }

  // ingest(model, json, {notifications}) -> { tweetIds, userIds, notifications, pinnedId }
  function ingest(model, json, opts) {
    const out = { tweetIds: [], userIds: [], notifications: [], isNotifications: Boolean(opts && opts.notifications) };
    let pinnedId = null;
    findInstructions(json && json.data, []).forEach((list) => {
      list.forEach((ins) => {
        const type = ins.type || ins.__typename;
        if (type === 'TimelinePinEntry' && ins.entry) {
          const sub = { tweetIds: [], userIds: [], notifications: [] };
          readEntry(model, ins.entry, sub);
          if (sub.tweetIds[0]) { pinnedId = sub.tweetIds[0]; model.tweets[pinnedId].pinned = true; }
        } else if (type === 'TimelineAddEntries') {
          (ins.entries || []).forEach((e) => readEntry(model, e, out));
        } else if (type === 'TimelineAddToModule') {
          (ins.moduleItems || []).forEach((it) => readItemContent(model, it.item && it.item.itemContent, out, it.entryId));
        }
      });
    });
    if (pinnedId) out.tweetIds.unshift(pinnedId);
    // Direct user lookups (UserByScreenName / UserByRestId)
    const direct = json && json.data && json.data.user && json.data.user.result;
    if (direct && direct.__typename === 'User') out.user = readUser(model, direct);
    return out;
  }

  function emptyModel(viewerId) {
    return { viewerId: viewerId || null, users: {}, tweets: {}, notifications: [] };
  }

  X.classic = { ingest, emptyModel, readUser, readTweet };
  if (typeof module !== 'undefined' && module.exports) module.exports = X.classic;
})(typeof window !== 'undefined' ? window : globalThis);
