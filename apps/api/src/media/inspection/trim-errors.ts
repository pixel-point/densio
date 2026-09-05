import { Schema } from "effect";

export class TrimRangeInvalid extends Schema.TaggedErrorClass<TrimRangeInvalid>()(
  "TrimRangeInvalid",
  {
    message: Schema.String,
  },
) {}
export class TrimTimelineUnsupported extends Schema.TaggedErrorClass<TrimTimelineUnsupported>()(
  "TrimTimelineUnsupported",
  {
    message: Schema.String,
  },
) {}
