import type {Context} from "grammy";

import {trimToUndefined} from "../../../lib/strings.js";

type TelegramMessage = Context["msg"];

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderTelegramContact(contact: NonNullable<TelegramMessage>["contact"]): string {
  const name = [contact?.first_name, contact?.last_name]
    .map((part) => trimToUndefined(part))
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const lines = [
    "Telegram contact:",
    `name: ${name || "unknown"}`,
    `phone_number: ${trimToUndefined(contact?.phone_number) ?? "unknown"}`,
    contact?.user_id === undefined ? undefined : `telegram_user_id: ${contact.user_id}`,
  ];
  const vcard = trimToUndefined(contact?.vcard);
  if (vcard) {
    lines.push("vcard:", vcard);
  }

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function renderTelegramLocation(
  location: NonNullable<TelegramMessage>["location"],
  label = "location",
): string {
  const latitude = readFiniteNumber(location?.latitude);
  const longitude = readFiniteNumber(location?.longitude);
  const mapUrl = latitude === undefined || longitude === undefined
    ? undefined
    : `https://maps.google.com/?q=${latitude},${longitude}`;

  return [
    `Telegram ${label}:`,
    latitude === undefined ? undefined : `latitude: ${latitude}`,
    longitude === undefined ? undefined : `longitude: ${longitude}`,
    location?.horizontal_accuracy === undefined ? undefined : `horizontal_accuracy: ${location.horizontal_accuracy}`,
    location?.live_period === undefined ? undefined : `live_period: ${location.live_period}`,
    location?.heading === undefined ? undefined : `heading: ${location.heading}`,
    location?.proximity_alert_radius === undefined ? undefined : `proximity_alert_radius: ${location.proximity_alert_radius}`,
    `map: ${mapUrl ?? "unknown"}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function renderTelegramVenue(venue: NonNullable<TelegramMessage>["venue"]): string {
  const location = venue?.location;
  const latitude = readFiniteNumber(location?.latitude);
  const longitude = readFiniteNumber(location?.longitude);
  const mapUrl = latitude === undefined || longitude === undefined
    ? undefined
    : `https://maps.google.com/?q=${latitude},${longitude}`;

  return [
    "Telegram venue:",
    `title: ${trimToUndefined(venue?.title) ?? "unknown"}`,
    `address: ${trimToUndefined(venue?.address) ?? "unknown"}`,
    latitude === undefined ? undefined : `latitude: ${latitude}`,
    longitude === undefined ? undefined : `longitude: ${longitude}`,
    `map: ${mapUrl ?? "unknown"}`,
    venue?.foursquare_id ? `foursquare_id: ${venue.foursquare_id}` : undefined,
    venue?.foursquare_type ? `foursquare_type: ${venue.foursquare_type}` : undefined,
    venue?.google_place_id ? `google_place_id: ${venue.google_place_id}` : undefined,
    venue?.google_place_type ? `google_place_type: ${venue.google_place_type}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function extractTelegramStructuredText(message: TelegramMessage | undefined): string {
  if (!message) {
    return "";
  }

  const parts = [
    message.contact ? renderTelegramContact(message.contact) : undefined,
    message.venue ? renderTelegramVenue(message.venue) : undefined,
    !message.venue && message.location
      ? renderTelegramLocation(message.location, message.location.live_period === undefined ? "location" : "live location")
      : undefined,
  ];

  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Extracts model-facing text from supported Telegram text and structured message shapes. */
export function extractTelegramMessageText(message: TelegramMessage | undefined): string {
  const rawText = (message?.text ?? message?.caption)?.trim() ?? "";
  const structuredText = extractTelegramStructuredText(message);
  return [rawText, structuredText].filter(Boolean).join("\n\n");
}

export function describeTelegramMessageShape(message: TelegramMessage | undefined): string {
  if (!message) {
    return "empty";
  }

  const supportedKeys = [
    "text",
    "caption",
    "photo",
    "document",
    "voice",
    "sticker",
    "video",
    "audio",
    "animation",
    "video_note",
    "contact",
    "location",
    "venue",
    "poll",
    "dice",
    "game",
    "invoice",
    "story",
    "paid_media",
    "successful_payment",
    "users_shared",
    "chat_shared",
    "web_app_data",
  ];
  const keys = supportedKeys.filter((key) => key in message);
  return keys.length === 0 ? "unknown" : keys.join(",");
}

export function readTelegramSentAtMs(message: TelegramMessage | undefined): number | undefined {
  if (!message || typeof message.date !== "number" || !Number.isFinite(message.date) || message.date <= 0) {
    return undefined;
  }

  return message.date * 1_000;
}
