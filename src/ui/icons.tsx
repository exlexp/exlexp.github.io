import type { SVGProps } from 'react';
import {
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  CircleUserRound,
  Clock3,
  Download,
  Inbox,
  KeyRound,
  LockKeyhole,
  MessageCircle,
  Plus,
  Puzzle,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { siXmpp } from 'simple-icons';

export const ChatIcon = MessageCircle;
export const AccountsIcon = KeyRound;
export const ContactsIcon = UsersRound;
export const ShieldIcon = ShieldCheck;
export const SettingsIcon = Settings;
export const LockIcon = LockKeyhole;
export const SendIcon = SendHorizontal;
export const PlusIcon = Plus;
export const DownloadIcon = Download;
export const SearchIcon = Search;
export const ArrowIcon = ArrowRight;
export const PluginsIcon = Puzzle;
export const InboxIcon = Inbox;
export const UserIcon = CircleUserRound;
export const SentIcon = Check;
export const DeliveredIcon = CheckCheck;
export const PendingIcon = Clock3;
export const FailedIcon = CircleAlert;

export function XmppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d={siXmpp.path}/>
    </svg>
  );
}

export function ToxIcon() {
  return <img src="/icons/qtox.svg" alt="" aria-hidden="true"/>;
}
