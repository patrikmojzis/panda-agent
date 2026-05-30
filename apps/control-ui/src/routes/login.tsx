import {FormEvent, useState} from "react";
import {useNavigate} from "@tanstack/react-router";
import {LogIn} from "lucide-react";
import {Button} from "../components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../components/ui/card";
import {Input} from "../components/ui/input";
import {useAuth} from "../lib/auth";

export function LoginPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await auth.login(token.trim());
      setToken("");
      await navigate({to: "/"});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setPending(false);
    }
  }
  return <main className="flex min-h-screen items-center justify-center p-4"><Card className="w-full max-w-md"><CardHeader><CardTitle>Panda Control</CardTitle><CardDescription>Paste the one-time Control login token printed by the grant CLI. Tokens are never logged by the UI.</CardDescription></CardHeader><CardContent><form className="grid gap-4" onSubmit={submit}><div className="grid gap-2"><label className="text-sm font-medium" htmlFor="control-token">Login token</label><Input id="control-token" type="password" autoComplete="one-time-code" placeholder="panda-control-token" value={token} onChange={(event) => setToken(event.target.value)} autoFocus /></div>{error ? <p className="rounded-md border border-destructive/60 bg-destructive/20 p-3 text-sm" role="alert">{error}</p> : null}<Button type="submit" disabled={pending || token.trim().length === 0}><LogIn className="size-4" /> Sign in</Button></form></CardContent></Card></main>;
}
