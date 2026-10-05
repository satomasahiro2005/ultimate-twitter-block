// Fake data for the x-web harness (fixture mode). Deterministic: same
// output every run, so screenshots and DOM snapshots are stable.
// Every user is obviously fake (fake_ prefix, "(fake)" in the name).
(function (g) {
  'use strict';
  const X = g.XWH = g.XWH || {};

  // 2026-10-06 12:00 UTC
  const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  function avatarUrl(n) { return 'https://pbs.twimg.com/profile_images/xwh-fake/' + n + '_normal.png'; }

  function makeUsers() {
    const base = [
      // id, screenName, name, flags
      ['1001', 'fake_me', 'Me (fake viewer)', {}],
      ['1002', 'fake_alice', 'Alice (fake)', { following: true, followedBy: true, verified: 'blue' }],
      ['1003', 'fake_bob', 'Bob (fake)', { following: true }],
      ['1004', 'fake_carol', 'Carol (fake)', { followedBy: true }],
      ['1005', 'fake_dave_long', 'Dave Has A Really Long Display Name (fake)', { verified: 'blue' }],
      ['1006', 'fake_erin', 'Erin (fake)', { protected: true, followRequestSent: true }],
      ['1007', 'fake_frank', 'Frank (fake)', { blocking: true }],
      ['1008', 'fake_grace', 'Grace (fake)', { muting: true, following: true }],
      ['1009', 'fake_heidi', 'Heidi (fake)', { verified: 'business' }],
      ['1010', 'fake_ivan', 'Ivan (fake)', { following: true, followedBy: true }],
      ['1011', 'fake_judy', 'Judy (fake)', {}],
      ['1012', 'fake_mallory', 'Mallory (fake)', { blocking: true }],
      ['1013', 'fake_niaj', 'Niaj (fake)', { muting: true }],
      ['1014', 'fake_olivia', 'Olivia (fake)', { verified: 'government' }],
    ];
    const users = {};
    base.forEach(([id, screenName, name, flags], i) => {
      users[id] = Object.assign({
        id, screenName, name,
        avatar: avatarUrl(id),
        banner: id === '1001' || id === '1002' ? 'https://pbs.twimg.com/profile_banners/xwh-fake/' + id + '/1500x500' : null,
        bio: i % 3 === 0
          ? 'Fake account for offline tests. Not a real person. Likes long bios that wrap onto a second line so the cell height changes.'
          : 'Fake account for offline tests.',
        location: i % 2 === 0 ? 'Nowhere (fake)' : null,
        url: i % 4 === 1 ? 'https://example.com/' + screenName : null,
        createdAt: Date.UTC(2015 + (i % 8), i % 12, 1),
        followersCount: 1234 * (i + 1) * (i + 1),
        followingCount: 321 + i * 17,
        tweetsCount: 4567 + i * 89,
        verified: null, protected: false,
        following: false, followedBy: false, followRequestSent: false,
        blocking: false, muting: false,
      }, flags);
    });
    return users;
  }

  function makeTweets() {
    const t = {};
    let seq = 0;
    function add(authorId, text, extra) {
      seq += 1;
      const id = String(1900000000000000000n + BigInt(seq));
      t[id] = Object.assign({
        id, authorId, text,
        createdAt: NOW - seq * 37 * MIN,
        replyCount: seq * 3, retweetCount: seq * 7, likeCount: seq * 41, bookmarkCount: seq,
        viewCount: seq * 1234,
        liked: false, retweeted: false, bookmarked: false,
        quotedId: null, retweetedById: null, replyToScreenName: null, pinned: false, media: [],
      }, extra || {});
      return id;
    }
    const ids = {};
    ids.alice1 = add('1002', 'A plain fake post by Alice. Nothing to see here.');
    ids.bob1 = add('1003', 'Bob posts something long enough to wrap onto two lines at phone width, so we can see how the header row and the buttons behave when the text is long.');
    ids.carolMedia = add('1004', 'Carol attached a fake photo.', {
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/xwh-fake-photo-1?format=png&name=small', width: 1200, height: 675 }],
    });
    ids.daveQuoted = add('1005', 'Dave is quoted by Judy below.');
    ids.judyQuote = add('1011', 'Judy quotes Dave.', { quotedId: ids.daveQuoted });
    ids.heidiRt = add('1009', 'Heidi wrote this; Ivan reposted it.', { retweetedById: '1010' });
    ids.erinProt = add('1006', 'Erin is protected (fake).');
    ids.frankBlocked = add('1007', 'Frank is blocked by the viewer (fake).');
    ids.graceMuted = add('1008', 'Grace is muted by the viewer (fake).');
    ids.oliviaReply = add('1014', 'Olivia replies to Alice.', { replyToScreenName: 'fake_alice' });
    ids.mePost = add('1001', 'The viewer\'s own post. The extension must not add buttons here.');
    ids.alicePinned = add('1002', 'Alice pinned this fake post.', { pinned: true });
    ids.alice2 = add('1002', 'Another post by Alice.');
    // conversation for the detail page
    ids.focal = add('1002', 'Focal post of the conversation (fake). Replies below.');
    ids.reply1 = add('1003', 'Bob replies to the focal post.', { replyToScreenName: 'fake_alice' });
    ids.reply2 = add('1013', 'Niaj (muted) replies.', { replyToScreenName: 'fake_alice' });
    ids.reply3 = add('1012', 'Mallory (blocked) replies.', { replyToScreenName: 'fake_alice' });
    ids.reply4 = add('1011', 'Judy replies with a quote.', { replyToScreenName: 'fake_alice', quotedId: ids.carolMedia });
    return { tweets: t, ids };
  }

  function build(opts) {
    const loggedIn = !opts || opts.loggedIn !== false;
    const users = makeUsers();
    const { tweets, ids } = makeTweets();
    const notifications = [
      { id: 'n1', type: 'like', userIds: ['1002', '1003', '1010'], tweetId: ids.mePost, createdAt: NOW - 5 * MIN },
      { id: 'n2', type: 'follow', userIds: ['1004'], tweetId: null, createdAt: NOW - 20 * MIN },
      { id: 'n3', type: 'follow', userIds: ['1009', '1012', '1005'], tweetId: null, createdAt: NOW - HOUR },
      { id: 'n4', type: 'retweet', userIds: ['1005'], tweetId: ids.mePost, createdAt: NOW - 2 * HOUR },
      { id: 'n5', type: 'reply', userIds: ['1003'], tweetId: ids.reply1, createdAt: NOW - 3 * HOUR },
      { id: 'n6', type: 'mention', userIds: ['1011'], tweetId: ids.judyQuote, createdAt: NOW - DAY },
    ];
    return {
      viewerId: loggedIn ? '1001' : null,
      users, tweets, notifications, ids,
      // lists the screens use
      lists: {
        home: [ids.alicePinned, ids.alice1, ids.bob1, ids.carolMedia, ids.judyQuote, ids.heidiRt, ids.oliviaReply, ids.erinProt, ids.mePost, ids.frankBlocked, ids.graceMuted],
        profilePosts: [ids.alicePinned, ids.alice1, ids.heidiRt, ids.alice2],
        following: ['1003', '1002', '1008', '1010', '1005', '1006', '1009', '1014'],
        followers: ['1002', '1004', '1010', '1011', '1005', '1012', '1013'],
        verifiedFollowers: ['1002', '1005', '1009', '1014'],
        whoToFollow: ['1011', '1005', '1014'],
        searchTop: [ids.bob1, ids.judyQuote, ids.carolMedia],
        searchPeople: ['1003', '1005', '1006', '1007', '1011'],
        blocked: ['1007', '1012'],
        muted: ['1008', '1013'],
        conversation: [ids.reply1, ids.reply2, ids.reply3, ids.reply4],
      },
      // per-user connection lists (falls back to `lists`)
      userLists: {
        1001: { profilePosts: [ids.mePost] },
        1002: { following: ['1001', '1004', '1011', '1012'], followers: ['1001', '1003', '1010'], verifiedFollowers: ['1005'] },
        1007: { profilePosts: [ids.frankBlocked] },
        1006: { profilePosts: [ids.erinProt] },
      },
      now: NOW,
    };
  }

  X.fixtures = { build, NOW };
  if (typeof module !== 'undefined' && module.exports) module.exports = X.fixtures;
})(typeof window !== 'undefined' ? window : globalThis);
