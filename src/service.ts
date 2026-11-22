// The token the Photoloft service hands its own page, which its other
// requests carry; null without the service.
export async function serviceToken() {
  const response = await fetch('/api/token').catch(() => null)
  if (!response?.ok) return null
  return (await response.json()).token as string
}
