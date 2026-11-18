import { cityNames, regionCodes, regionNameOverrides, provinceNames } from './locationData.js'

export { regionCodes } from './locationData.js'

export const provinces = Object.entries(provinceNames).map(([code, name]) => ({
  code,
  name,
  cities: Object.entries(cityNames)
    .filter(([city]) => city.startsWith(code.slice(0, 2)))
    .map(([code, name]) => ({ code, name })),
}))

export type UserLocation = {
  region: string
  province?: string
  city?: string
}

const regions = new Set(regionCodes)
const regionNames = {
  'zh-CN': new Intl.DisplayNames(['zh-CN'], { type: 'region' }),
  'en-US': new Intl.DisplayNames(['en-US'], { type: 'region' }),
}

/** 界面语言可能是自定义语言（custom:<id>）：地区名只用内置中英文表，非英文一律按中文。 */
export const getRegionName = (code: string, locale: string): string => {
  const builtin: 'zh-CN' | 'en-US' = locale === 'en-US' ? 'en-US' : 'zh-CN'
  return regions.has(code)
    ? (regionNameOverrides[builtin][code] ?? regionNames[builtin].of(code) ?? code)
    : ''
}

export const normalizeLocation = (value: unknown): UserLocation | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const location = value as Record<string, unknown>
  const { region, province, city } = location
  if (typeof region !== 'string' || !regions.has(region)) {
    return null
  }
  if (region !== 'CN') {
    return { region }
  }
  if (province === undefined) {
    return city === undefined ? { region } : null
  }
  const selectedProvince = provinces.find((item) => item.code === province)
  if (!selectedProvince) {
    return null
  }
  if (city === undefined) {
    return { region, province: selectedProvince.code }
  }
  const selectedCity = selectedProvince.cities.find((item) => item.code === city)
  return selectedCity ? { region, province: selectedProvince.code, city: selectedCity.code } : null
}
