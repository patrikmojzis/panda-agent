export function renderDateTimeContext(options: {
  formattedDateTime: string;
  timeZone: string;
  weekday: string;
  month: string;
}): string {
  return `
Current local date and time: ${options.formattedDateTime}
Timezone: ${options.timeZone}
Weekday: ${options.weekday}
Month: ${options.month}
`.trim();
}
