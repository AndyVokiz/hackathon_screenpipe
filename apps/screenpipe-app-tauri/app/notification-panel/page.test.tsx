// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import posthog from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotificationPanelPage from "./page";

const bridge = vi.hoisted(() => ({
  receive: (_event: { payload: string }) => {},
  copy: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(undefined),
  execute: vi.fn().mockResolvedValue(undefined),
  feedback: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  ready: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name, callback) => {
    // The hint card also listens (for run progress); keep the panel's own.
    if (name === "notification-panel-update") bridge.receive = callback;
    return Promise.resolve(() => {});
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    copyTextToClipboard: bridge.copy,
    hideNotificationPanel: bridge.hide,
    showNotificationPanel: bridge.show,
    nextStepFeedback: bridge.feedback,
    notificationPanelReady: bridge.ready,
  },
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("localforage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue([]),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/components/markdown", () => ({
  notificationUrlTransform: (url: string) => url,
  openScreenpipeViewerLink: vi.fn(),
  screenpipeViewerPathFromHref: vi.fn(),
}));
vi.mock("@/lib/notifications/actions", () => ({
  executeNotificationAction: bridge.execute,
  routeNotificationDeeplink: vi.fn().mockResolvedValue(undefined),
}));

const payload = {
  id: "compact-notification",
  type: "pipe",
  title: "Ready for review",
  body: "A proposal is ready.",
  pipe_name: "scaling",
  autoDismissMs: 0,
  actions: [
    {
      type: "deeplink",
      label: "Review",
      primary: true,
      url: "screenpipe://home",
    },
    { type: "dismiss", label: "Dismiss" },
  ],
};
async function deliver(data = payload) {
  await act(async () => {
    bridge.receive({ payload: JSON.stringify(data) });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("compact notification panel", () => {
  it("keeps a single dismissal and reveals utilities and feedback only on request", async () => {
    render(<NotificationPanelPage />);
    await deliver();
    expect(screen.getAllByRole("button", { name: /dismiss/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("Ready for review"));
    expect(
      screen.queryByRole("button", { name: "Copy notification" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Useful notification" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Notification options" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy notification" }));
    await waitFor(() =>
      expect(bridge.copy).toHaveBeenCalledWith(
        "Ready for review\n\nA proposal is ready.",
      ),
    );
    expect(bridge.hide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Not useful notification" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "What should improve" }),
      { target: { value: "Include the source" } },
    );
    fireEvent.mouseLeave(screen.getByText("Ready for review"));
    expect(
      screen.getByRole("textbox", { name: "What should improve" }),
    ).toHaveValue("Include the source");
    await deliver({ ...payload, id: "next" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notification options" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(bridge.hide).toHaveBeenCalledTimes(1);
  });

  it("shows a remote image in the body as alt text without loading it", async () => {
    const { container } = render(<NotificationPanelPage />);
    await deliver({
      ...payload,
      body: "chart below ![remote chart](https://example.com/x.png?d=secret)",
    });
    // The panel's own app icon is an <img>, so check only the body.
    const body = container.querySelector(".notif-md");
    expect(body).toHaveTextContent("chart below remote chart");
    expect(body?.querySelector("img")).toBeNull();
    expect(container.querySelector("img[src*='example.com']")).toBeNull();
  });

  it("pauses expiration while options are open and resumes when closed", async () => {
    vi.useFakeTimers();
    render(<NotificationPanelPage />);
    await deliver({ ...payload, autoDismissMs: 1000 });
    fireEvent.click(
      screen.getByRole("button", { name: "Notification options" }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(bridge.hide).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Notification options" }),
    );
    act(() => vi.advanceTimersByTime(1200));
    expect(bridge.hide).toHaveBeenCalledTimes(1);
  });
});


describe("cold panel delivery", () => {
  const shownCount = () =>
    vi
      .mocked(posthog.capture)
      .mock.calls.filter(([name]) => name === "notification_shown").length;

  it("shows a payload Rust emitted before the page was listening", async () => {
    bridge.ready.mockResolvedValueOnce(JSON.stringify(payload));
    render(<NotificationPanelPage />);
    expect(await screen.findByText("Ready for review")).toBeInTheDocument();
    expect(bridge.ready).toHaveBeenCalledTimes(1);
  });

  it("does not redraw when the delayed emit repeats the taken payload", async () => {
    bridge.ready.mockResolvedValueOnce(JSON.stringify(payload));
    render(<NotificationPanelPage />);
    await screen.findByText("Ready for review");
    fireEvent.click(
      screen.getByRole("button", { name: "Notification options" }),
    );
    await deliver();
    expect(
      screen.getByRole("button", { name: "Notification options" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(shownCount()).toBe(1);
  });

  it("shows the same payload again once it was dismissed", async () => {
    render(<NotificationPanelPage />);
    await deliver();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(bridge.hide).toHaveBeenCalled());
    await deliver();
    expect(shownCount()).toBe(2);
  });
});

describe("meeting join notification delivery", () => {
  const meeting = {
    ...payload, type: "meeting", title: "meeting starting in 1 min",
    actions: [
      { type: "meeting_join", id: "join", label: "join and take notes", url: "https://meet.google.com/example", primary: true },
      { type: "api", id: "hd", label: "+ HD", url: "/capture/hd/start", method: "POST", body: { boundTo: "prewarm_pending" } },
    ],
  };
  it("renders the split card and dispatches join + HD from the incoming notification", async () => {
    render(<NotificationPanelPage />);
    await deliver(meeting);
    fireEvent.click(screen.getByRole("button", { name: "Join and take notes with HD screen recording" }));
    await waitFor(() => expect(bridge.hide).toHaveBeenCalledTimes(1));
    expect(bridge.execute).toHaveBeenCalledWith(expect.objectContaining({ type: "meeting_join", url: meeting.actions[0].url, screen_detail: { boundTo: "prewarm_pending" } }), expect.anything());
    expect(screen.queryByRole("button", { name: "Notification options" })).toBeNull();
  });
  it("shows capture failure only after closing the join card", async () => {
    bridge.execute.mockImplementationOnce(async (_action, context) => context.onScreenDetailError());
    render(<NotificationPanelPage />);
    await deliver(meeting);
    fireEvent.click(screen.getByRole("button", { name: "Join and take notes with HD screen recording" }));
    await waitFor(() => expect(bridge.show).toHaveBeenCalledTimes(1));
    expect(JSON.parse(bridge.show.mock.calls[0][0])).toMatchObject({ type: "warning", title: "Screen detail could not start" });
    expect(bridge.hide.mock.invocationCallOrder[0]).toBeLessThan(bridge.show.mock.invocationCallOrder[0]);
  });
});

describe("next step hint delivery", () => {
  // Fictional content only.
  const hint = {
    ...payload,
    id: "hint-1",
    type: "next_step_hint",
    title: "Add STRIPE_KEY to .env.local",
    body: "1. Open .env.local\n\nBased on Code · checkout.ts · last 4 min",
    autoDismissMs: 45000,
    actions: [],
    hint: {
      hintId: "hint-1",
      title: "Add STRIPE_KEY to .env.local",
      how: ["Open .env.local"],
      appName: "Code",
      sourceLine: "Based on Code · checkout.ts · last 4 min",
      frameId: 7,
      automatable: false,
      risk: "safe",
      effect: "",
      confidenceBucket: "0.7-0.8",
      latencyMs: 900,
    },
  };

  it("renders the hint card for next_step_hint and the usual layout otherwise", async () => {
    render(<NotificationPanelPage />);
    await deliver(hint);
    expect(screen.getByRole("region", { name: "Next step" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Notification options" })).toBeNull();

    await deliver({ ...payload, id: "plain", type: "next_step_hint" });
    expect(screen.queryByRole("region", { name: "Next step" })).toBeNull();
    expect(screen.getByRole("button", { name: "Notification options" })).toBeInTheDocument();
  });

  it("leaves the timing to the card: hidden at 45 s, not at the page default", async () => {
    vi.useFakeTimers();
    render(<NotificationPanelPage />);
    await deliver(hint);
    act(() => vi.advanceTimersByTime(44_000));
    expect(bridge.hide).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(bridge.hide).toHaveBeenCalledTimes(1);
    expect(bridge.feedback).toHaveBeenCalledWith("hint-1", "timeout");
  });
});
