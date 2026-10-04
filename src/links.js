import { normalizeProfile } from './core.js';

// Only use recipient-specific links observed on the profile, never guess a member ID.
export function composeLink(person, action) {
  const fallback = normalizeProfile(person.url);
  try {
    const url = new URL(action === 'dm' ? person.messagingUrl : person.invitationUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com') return fallback;
    if (action === 'dm' && url.pathname === '/messaging/compose/' && url.searchParams.get('recipient')) {
      const target = new URL('https://www.linkedin.com/messaging/compose/');
      target.searchParams.set('recipient', url.searchParams.get('recipient'));
      if (url.searchParams.get('profileUrn')) target.searchParams.set('profileUrn', url.searchParams.get('profileUrn'));
      return target.href;
    }
    if (action === 'connection_request' && url.pathname === '/preload/custom-invite/' &&
        url.searchParams.get('vanityName') === decodeURIComponent(new URL(fallback).pathname.split('/')[2])) {
      const target = new URL('https://www.linkedin.com/preload/custom-invite/');
      target.searchParams.set('vanityName', url.searchParams.get('vanityName'));
      return target.href;
    }
  } catch { /* Missing or unsupported UI link: open the profile instead. */ }
  return fallback;
}

// References the current row dynamically, including the latest manually edited message.
// Only this trusted formula is written as USER_ENTERED; profile/message content stays RAW.
export const SEND_FORMULA = '=IF(INDEX(Q:Q,ROW())="","",HYPERLINK(INDEX(Q:Q,ROW())&IF(REGEXMATCH(INDEX(Q:Q,ROW()),"/messaging/compose/"),"&body="&ENCODEURL(INDEX(L:L,ROW())),""),IF(REGEXMATCH(INDEX(Q:Q,ROW()),"/messaging/compose/"),"Open message ↗",IF(REGEXMATCH(INDEX(Q:Q,ROW()),"/preload/custom-invite/"),"Open invitation ↗","Open profile ↗"))))';
