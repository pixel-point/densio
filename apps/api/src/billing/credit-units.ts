export const CREDIT_UNITS_PER_CREDIT = 100;
export const MINIMUM_JOB_CREDIT_UNITS = 5;

export const creditsFromUnits = (units: number) => units / CREDIT_UNITS_PER_CREDIT;

export const monthlyCreditUnits = (credits: number) => credits * CREDIT_UNITS_PER_CREDIT;
