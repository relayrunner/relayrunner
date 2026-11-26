/** The page's own `?sample=`, for previews of a state the sample workspace isn't in. */
export const sampleParam = () => new URLSearchParams(window.location.search).get("sample");
