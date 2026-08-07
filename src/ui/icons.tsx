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
  Pencil,
  Puzzle,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  UsersRound,
  X,
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
export const EditIcon = Pencil;
export const CancelIcon = X;
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
  return <img src={`${import.meta.env.BASE_URL}icons/qtox.svg`} alt="" aria-hidden="true"/>;
}

export function RelaylessLogo(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 188 177" fill="none" aria-hidden="true" {...props}><path d="M53.4668 154.158V176.147H4.53027L53.4668 154.158Z" fill="currentColor"/><path fillRule="evenodd" clipRule="evenodd" d="M113.647 0C129.842 0 143.473 2.27865 154.541 6.83594C165.609 11.3932 173.95 17.985 179.565 26.6113C185.181 35.1562 187.624 45.793 187.624 58V65.1055L187.988 176.147H134.888L55.0293 117.34L0 139.019V0H113.647ZM53.4668 83.1299H108.521C116.659 83.1299 123.006 81.1361 127.563 77.1484C132.121 73.0794 134.399 67.4642 134.399 60.3027V60.0586C134.399 53.0599 132.039 47.526 127.319 43.457C122.681 39.388 116.333 37.3535 108.276 37.3535H53.4668V83.1299Z" fill="currentColor"/></svg>;
}
