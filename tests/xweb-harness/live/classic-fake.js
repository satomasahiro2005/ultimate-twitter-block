'use strict';

// Classic-app-shaped GraphQL responses built from the fixture model, so live
// mode can be exercised end to end offline (live/selftest.js). Shapes follow
// the classic web app's responses as of 2026: user `core`/`avatar`/
// `relationship_perspectives` plus `legacy` counts; tweets with `core.user_results`,
// `legacy`, `views`, `quoted_status_result`; timelines as `instructions`.

const fixtures = require('../data/fixtures.js');

function classicDate(ms) {
  // "Tue Oct 06 11:23:00 +0000 2026"
  const d = new Date(ms);
  const s = d.toUTCString(); // "Tue, 06 Oct 2026 11:23:00 GMT"
  const [wd, dd, mon, yyyy, time] = s.replace(',', '').split(' ');
  return `${wd} ${mon} ${dd} ${time} +0000 ${yyyy}`;
}

function user(u) {
  return {
    __typename: 'User',
    id: Buffer.from('User:' + u.id).toString('base64'),
    rest_id: u.id,
    avatar: { image_url: u.avatar },
    core: { created_at: classicDate(u.createdAt), name: u.name, screen_name: u.screenName },
    is_blue_verified: u.verified === 'blue',
    verification: u.verified === 'business' ? { verified: false, verified_type: 'Business' } : u.verified === 'government' ? { verified: false, verified_type: 'Government' } : { verified: false },
    location: { location: u.location || '' },
    privacy: { protected: u.protected },
    profile_bio: { description: u.bio },
    relationship_perspectives: { following: u.following, followed_by: u.followedBy, blocking: u.blocking, muting: u.muting, follow_request_sent: u.followRequestSent },
    legacy: {
      description: u.bio,
      followers_count: u.followersCount,
      friends_count: u.followingCount,
      statuses_count: u.tweetsCount,
      profile_banner_url: u.banner ? u.banner.replace(/\/1500x500$/, '') : undefined,
      url: u.url ? 'https://t.co/fake' : undefined,
      entities: u.url ? { url: { urls: [{ expanded_url: u.url, url: 'https://t.co/fake' }] } } : {},
    },
  };
}

function tweet(m, t, depth) {
  const res = {
    __typename: 'Tweet',
    rest_id: t.id,
    core: { user_results: { result: user(m.users[t.authorId]) } },
    views: { count: String(t.viewCount), state: 'EnabledWithCount' },
    legacy: {
      id_str: t.id,
      created_at: classicDate(t.createdAt),
      full_text: t.text + (t.media.length ? ' https://t.co/fakemedia' : ''),
      favorite_count: t.likeCount, retweet_count: t.retweetCount, reply_count: t.replyCount, quote_count: 0, bookmark_count: t.bookmarkCount,
      favorited: t.liked, retweeted: t.retweeted, bookmarked: t.bookmarked,
      in_reply_to_screen_name: t.replyToScreenName || undefined,
      user_id_str: t.authorId,
      extended_entities: t.media.length ? { media: t.media.map((x) => ({ type: 'photo', media_url_https: x.url, original_info: { width: x.width, height: x.height } })) } : undefined,
    },
  };
  if (t.quotedId && depth < 1) res.quoted_status_result = { result: tweet(m, m.tweets[t.quotedId], depth + 1) };
  if (t.retweetedById) {
    // classic: the timeline entry is the reposter's wrapper tweet
    return {
      __typename: 'Tweet', rest_id: '8' + t.id.slice(1),
      core: { user_results: { result: user(m.users[t.retweetedById]) } },
      legacy: { id_str: '8' + t.id.slice(1), created_at: classicDate(t.createdAt), full_text: 'RT', retweeted_status_result: { result: Object.assign({}, res) } },
    };
  }
  return { __typename: 'TweetWithVisibilityResults', tweet: res };
}

function tweetEntry(m, id) {
  const t = m.tweets[id];
  return { entryId: 'tweet-' + id, sortIndex: id, content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: tweet(m, t, 0) }, tweetDisplayType: 'Tweet' } } };
}
function userEntry(m, id) {
  return { entryId: 'user-' + id, sortIndex: id, content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', __typename: 'TimelineUser', user_results: { result: user(m.users[id]) }, userDisplayType: 'User' } } };
}
const cursor = (v) => ({ entryId: 'cursor-bottom-' + v, sortIndex: '0', content: { entryType: 'TimelineTimelineCursor', __typename: 'TimelineTimelineCursor', value: 'fake-cursor', cursorType: 'Bottom' } });
const timeline = (entries, extra) => ({ timeline: { instructions: [{ type: 'TimelineClearCache' }].concat(extra || [], [{ type: 'TimelineAddEntries', entries: entries.concat([cursor(1)]) }]) } });

// op name + variables -> JSON
function respond(op, vars) {
  const fx = fixtures.build({ loggedIn: true });
  const m = fx;
  const L = fx.lists;
  const bySn = (sn) => Object.values(m.users).find((u) => u.screenName.toLowerCase() === String(sn).toLowerCase());
  switch (op) {
    case 'UserByScreenName': {
      const u = bySn(vars.screen_name);
      return u ? { data: { user: { result: user(u) } } } : { data: {} };
    }
    case 'UserTweets': {
      const ids = vars.userId === '1001' ? [fx.ids.mePost] : L.profilePosts;
      const pinned = ids.filter((id) => m.tweets[id].pinned);
      return { data: { user: { result: { __typename: 'User', timeline: timeline(ids.filter((id) => !m.tweets[id].pinned).map((id) => tweetEntry(m, id)), pinned.map((id) => ({ type: 'TimelinePinEntry', entry: Object.assign(tweetEntry(m, id), { content: Object.assign(tweetEntry(m, id).content, { clientEventInfo: {} }) }) }))) } } } };
    }
    case 'Following': return { data: { user: { result: { __typename: 'User', timeline: timeline(L.following.map((id) => userEntry(m, id))) } } } };
    case 'Followers': return { data: { user: { result: { __typename: 'User', timeline: timeline(L.followers.map((id) => userEntry(m, id))) } } } };
    case 'BlueVerifiedFollowers': return { data: { user: { result: { __typename: 'User', timeline: timeline(L.verifiedFollowers.map((id) => userEntry(m, id))) } } } };
    case 'HomeTimeline': case 'HomeLatestTimeline':
      return { data: { home: { home_timeline_urt: timeline(L.home.map((id) => tweetEntry(m, id))).timeline } } };
    case 'TweetDetail':
      return { data: { threaded_conversation_with_injections_v2: timeline([tweetEntry(m, vars.focalTweetId)].concat(L.conversation.map((id) => ({
        entryId: 'conversationthread-' + id, sortIndex: id,
        content: { entryType: 'TimelineTimelineModule', __typename: 'TimelineTimelineModule', displayType: 'VerticalConversation', items: [{ entryId: 'conversationthread-' + id + '-tweet-' + id, item: tweetEntry(m, id).content }] },
      })))).timeline } };
    case 'SearchTimeline':
      return { data: { search_by_raw_query: { search_timeline: timeline(vars.product === 'People' ? L.searchPeople.map((id) => userEntry(m, id)) : L.searchTop.map((id) => tweetEntry(m, id))) } } };
    case 'BlockedAccountsAll': return { data: { viewer: { timeline: timeline(L.blocked.map((id) => userEntry(m, id))) } } };
    case 'MutedAccounts': return { data: { viewer: { muting_timeline: timeline(L.muted.map((id) => userEntry(m, id))) } } };
    case 'ConnectTabTimeline': return { data: { connect_tab_timeline: timeline(L.whoToFollow.map((id) => userEntry(m, id))) } };
    case 'NotificationsTimeline': {
      const icon = { like: 'heart_icon', retweet: 'retweet_icon', follow: 'person_icon' };
      const entries = fx.notifications.map((n) => {
        if (icon[n.type]) {
          return { entryId: 'notification-' + n.id, sortIndex: String(n.createdAt), content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: {
            itemType: 'TimelineNotification', __typename: 'TimelineNotification', id: n.id, notification_icon: icon[n.type], timestamp_ms: String(n.createdAt),
            rich_message: { text: 'fake' },
            template: { __typename: 'TimelineNotificationAggregateUserActionsV1', from_users: n.userIds.map((id) => ({ user_results: { result: user(m.users[id]) } })), target_objects: n.tweetId ? [{ tweet_results: { result: tweet(m, m.tweets[n.tweetId], 0) } }] : [] },
          } } };
        }
        return tweetEntry(m, n.tweetId);
      });
      return { data: { viewer_v2: { user_results: { result: { notification_timeline: timeline(entries) } } } } };
    }
    default: return null;
  }
}

const OPS = ['UserByScreenName', 'UserTweets', 'Following', 'Followers', 'BlueVerifiedFollowers', 'HomeTimeline', 'HomeLatestTimeline', 'TweetDetail', 'SearchTimeline', 'BlockedAccountsAll', 'MutedAccounts', 'ConnectTabTimeline', 'NotificationsTimeline'];

// A stand-in for the classic main.js: just the parts live.js discovers.
function fakeMainJs() {
  const ops = OPS.map((op) => `${op.length}:function(e){e.exports={queryId:"fake${op}Id",operationName:"${op}",operationType:"query",metadata:{featureSwitches:["fake_feature_a","fake_feature_b"],fieldToggles:["withFakeToggle"]}}}`).join(',');
  return `/* fake classic main.js for xweb-harness selftest */ var t="AAAAAAAAAAAAAAAAAAAAAFAKEFAKEFAKEFAKE%3Dfake";({${ops}});`;
}

module.exports = { respond, fakeMainJs, OPS };
