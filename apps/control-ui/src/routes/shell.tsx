import {Link, Outlet, useNavigate} from "@tanstack/react-router";
import {Activity, AlarmClock, Bot, Eye, FileText, Gauge, HeartPulse, KeyRound, ListTodo, LogOut, ScrollText, Settings} from "lucide-react";
import {Button} from "../components/ui/button";
import {Badge} from "../components/ui/badge";
import {useAuth} from "../lib/auth";
import {cn} from "../lib/utils";

const nav = [
  {to: "/", label: "Home", icon: Gauge},
  {to: "/agents", label: "Agents", icon: Bot},
  {to: "/credentials", label: "Credentials", icon: KeyRound},
  {to: "/audit", label: "Audit", icon: ScrollText},
  {to: "/briefing", label: "Briefing", icon: FileText},
  {to: "/heartbeat", label: "Heartbeat", icon: HeartPulse},
  {to: "/todos", label: "Todos", icon: ListTodo},
  {to: "/watches", label: "Watches", icon: Eye},
  {to: "/runtime-activity", label: "Runtime", icon: Activity},
  {to: "/scheduled-tasks", label: "Scheduled tasks", icon: AlarmClock},
] as const;

export function Shell() {
  const auth = useAuth();
  const navigate = useNavigate();
  async function logout() {
    await auth.logout();
    await navigate({to: "/login"});
  }
  return <div className="min-h-screen max-w-full overflow-x-hidden bg-background"><div className="flex min-h-screen min-w-0 flex-col lg:flex-row"><aside className="border-b bg-card/80 p-4 lg:w-64 lg:border-b-0 lg:border-r"><div className="flex items-center justify-between gap-3 lg:block"><div><p className="text-lg font-semibold">Panda Control</p><p className="text-xs text-muted-foreground">Operator shell</p></div>{auth.session ? <Badge variant="secondary">{auth.session.role}</Badge> : null}</div><nav className="mt-4 flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">{nav.map(({to, label, icon: Icon}) => <Link key={to} to={to} className="min-w-max rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [&.active]:bg-secondary [&.active]:text-foreground"><span className="flex items-center gap-2"><Icon className="size-4" /> {label}</span></Link>)}<button className="min-w-max cursor-not-allowed rounded-md px-3 py-2 text-left text-sm text-muted-foreground/60" disabled><span className="flex items-center gap-2"><Settings className="size-4" /> Settings</span></button></nav></aside><div className="flex min-w-0 flex-1 flex-col"><header className="flex items-center justify-between gap-3 border-b p-4"><div className="min-w-0"><h1 className="truncate text-xl font-semibold">Control dashboard</h1><p className="truncate text-sm text-muted-foreground">Authenticated as {auth.session?.identityId ?? "unknown"}</p></div><Button variant="outline" size="sm" onClick={() => void logout()}><LogOut className="size-4" /> Logout</Button></header><main className="min-w-0 flex-1 overflow-x-hidden p-4 lg:p-6"><div className={cn("mx-auto grid max-w-6xl gap-4")}><Outlet /></div></main></div></div></div>;
}
