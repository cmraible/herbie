import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { ApiError, createClient } from "@herbie/contracts/client";
import { streamMessageSchema, type Goal, type GoalEvent, type Session } from "@herbie/contracts";

const api = createClient();

type SessionState = "pending" | "signed-in" | "signed-out" | "error";
type EventsState = "idle" | "loading" | "loaded" | "error";

interface GoalStreamOptions {
  session: Session | null;
  selected: string | null;
  setSession: Dispatch<SetStateAction<Session | null>>;
  setSessionState: Dispatch<SetStateAction<SessionState>>;
  setReconnecting: Dispatch<SetStateAction<boolean>>;
  setGoals: Dispatch<SetStateAction<Goal[]>>;
  setGoalsLoaded: Dispatch<SetStateAction<boolean>>;
  setGoalsError: Dispatch<SetStateAction<string | null>>;
  setEvents: Dispatch<SetStateAction<GoalEvent[]>>;
  setEventsState: Dispatch<SetStateAction<EventsState>>;
  setEventsError: Dispatch<SetStateAction<string | null>>;
}

export function useGoalStream({
  session,
  selected,
  setSession,
  setSessionState,
  setReconnecting,
  setGoals,
  setGoalsLoaded,
  setGoalsError,
  setEvents,
  setEventsState,
  setEventsError,
}: GoalStreamOptions) {
  const revision = useRef(0);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let delay = 500;
    let timer: ReturnType<typeof setTimeout>;
    let socket: WebSocket;
    function connect() {
      if (disposed) return;
      const url = new URL("/api/stream", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      if (selected) url.searchParams.set("goal", selected);
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const update = streamMessageSchema.parse(JSON.parse(event.data));
          delay = 500;
          setReconnecting(false);
          if (update.type === "goals") {
            revision.current++;
            setGoals(update.goals);
            setGoalsLoaded(true);
            setGoalsError(null);
          } else if (update.goalId === selected) {
            setEvents((current) =>
              [...new Map([...current, ...update.events].map((item) => [item.id, item])).values()]
                .sort((a, b) => a.id - b.id),
            );
            setEventsState("loaded");
            setEventsError(null);
          }
        } catch {
          socket.close();
        }
      };
      socket.onclose = async (event) => {
        if (disposed) return;
        if (event.code === 1008) {
          setSession(null);
          setSessionState("signed-out");
          return;
        }
        setReconnecting(true);
        // Browsers hide HTTP 401 upgrade responses behind close code 1006.
        try {
          await api.session();
        } catch (failure) {
          if (disposed) return;
          if (failure instanceof ApiError && failure.status === 401) {
            setSession(null);
            setSessionState("signed-out");
            return;
          }
        }
        if (disposed) return;
        timer = setTimeout(connect, delay + (Math.random() * delay) / 2);
        delay = Math.min(delay * 2, 30_000);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.close();
    };
  }, [
    session,
    selected,
    setSession,
    setSessionState,
    setReconnecting,
    setGoals,
    setGoalsLoaded,
    setGoalsError,
    setEvents,
    setEventsState,
    setEventsError,
  ]);

  return revision;
}
