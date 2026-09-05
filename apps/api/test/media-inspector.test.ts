import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  type MediaProcessCommand,
  type MediaProcessResult,
  MediaProcessRunner,
} from "../src/media/process/media-process-runner.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";

const versions = {
  ffmpeg: "ffmpeg version 7.1-static\n",
  ffprobe: "ffprobe version 7.1-static\n",
  encoders: [
    " V....D libvpx-vp9 VP9",
    " V....D libx265 H.265",
    " V..... libsvtav1 AV1",
    " A..... aac AAC",
  ].join("\n"),
};

describe("media inspector process integration", () => {
  it("uses the configured binaries for all startup capability probes", async () => {
    const fixture = inspectorFixture((command) => capabilityResponse(command));
    const capabilities = await runInspector(
      MediaInspector.use((inspector) => inspector.checkCapabilities()),
      fixture.layer,
    );

    expect(capabilities).toMatchObject({ ffmpegVersion: "7.1-static" });
    expect(fixture.commands).toEqual(
      expect.arrayContaining([
        { arguments: ["-hide_banner", "-version"], executable: "/host/ffmpeg" },
        { arguments: ["-hide_banner", "-version"], executable: "/host/ffprobe" },
        { arguments: ["-hide_banner", "-encoders"], executable: "/host/ffmpeg" },
      ]),
    );
  });

  it("inspects media through structured ffprobe JSON", async () => {
    const fixture = inspectorFixture(() =>
      result(
        JSON.stringify({
          format: { duration: "3.5" },
          streams: [
            {
              index: 0,
              codec_type: "video",
              width: 640,
              height: 360,
              avg_frame_rate: "24/1",
            },
          ],
        }),
      ),
    );
    const media = await runInspector(
      MediaInspector.use((inspector) => inspector.inspect("/uploads/input.mp4")),
      fixture.layer,
    );

    expect(media.durationSeconds).toBe(3.5);
    expect(fixture.commands[0]).toEqual({
      executable: "/host/ffprobe",
      arguments: [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "/uploads/input.mp4",
      ],
    });
  });
});

describe("media inspector analysis integration", () => {
  it("resolves exact frames using per-frame JSON from the inspected video stream", async () => {
    const fixture = inspectorFixture(() =>
      result(JSON.stringify({ frames: [{ best_effort_timestamp_time: "1.2" }] })),
    );
    const timestamp = await runInspector(
      MediaInspector.use((inspector) =>
        inspector.resolveFrameTimestamp("/uploads/input.mp4", 0, 2),
      ),
      fixture.layer,
    );

    expect(timestamp).toBe(1.2);
    expect(fixture.commands[0]?.arguments).toEqual([
      "-v",
      "error",
      "-select_streams",
      "2",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time,pts_time",
      "-print_format",
      "json",
      "/uploads/input.mp4",
    ]);
  });

  it("analyzes every audio stream and keeps media when any is audible", async () => {
    const fixture = inspectorFixture((command) =>
      result(command.arguments.includes("0:2") ? peak("-30") : peak("-80")),
    );
    const classification = await runInspector(
      MediaInspector.use((inspector) => inspector.classifyAudio("/uploads/input.mp4", [1, 2])),
      fixture.layer,
    );

    expect(classification).toBe("audible");
    expect(
      fixture.commands.map(({ arguments: argv }) => argv.at(argv.indexOf("-map") + 1)),
    ).toEqual(["0:1", "0:2"]);
  });

  it("rejects truncated structured process output", async () => {
    const fixture = inspectorFixture(() => ({ ...result("{}"), stdoutTruncated: true }));
    const error = await runInspector(
      Effect.flip(MediaInspector.use((inspector) => inspector.inspect("input.mp4"))),
      fixture.layer,
    );

    expect(error).toMatchObject({ reason: "truncated-process-output" });
  });
});

const options = {
  ffmpegPath: "/host/ffmpeg",
  ffprobePath: "/host/ffprobe",
  silenceThresholdDb: -50,
};

const runInspector = <A, E>(
  program: Effect.Effect<A, E, MediaInspector>,
  runnerLayer: Layer.Layer<MediaProcessRunner>,
) =>
  Effect.runPromise(
    program.pipe(Effect.provide(MediaInspector.layer(options).pipe(Layer.provide(runnerLayer)))),
  );

const inspectorFixture = (respond: (command: MediaProcessCommand) => MediaProcessResult) => {
  const commands: Array<MediaProcessCommand> = [];
  const layer = Layer.succeed(
    MediaProcessRunner,
    MediaProcessRunner.of({
      run: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return respond(command);
        }),
    }),
  );

  return { commands, layer };
};

const capabilityResponse = (command: MediaProcessCommand) => {
  if (command.arguments.includes("-encoders")) return result(versions.encoders);
  return result(command.executable.includes("ffprobe") ? versions.ffprobe : versions.ffmpeg);
};

const result = (stdout: string): MediaProcessResult => ({
  exitCode: 0,
  stderrTail: "",
  stdout,
  stdoutTruncated: false,
});

const peak = (value: string) => `lavfi.astats.Overall.Peak_level=${value}\n`;
