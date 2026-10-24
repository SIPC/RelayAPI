import "server-only";

// CPA 8289ec4c model capability snapshot used by the request adapter.
export const CLAUDE_MODEL_POLICIES: {
  id: string;
  thinking?: { min?: number; max?: number; zero_allowed?: boolean; dynamic_allowed?: boolean; disable_type?: string; levels?: string[] };
  max_completion_tokens: number;
}[] = [
  {
    "id": "claude-haiku-4-5-20251001",
    "thinking": {
      "min": 1024,
      "max": 128000,
      "zero_allowed": true
    },
    "max_completion_tokens": 64000
  },
  {
    "id": "claude-sonnet-4-5-20250929",
    "thinking": {
      "min": 1024,
      "max": 128000,
      "zero_allowed": true
    },
    "max_completion_tokens": 64000
  },
  {
    "id": "claude-sonnet-4-6",
    "thinking": {
      "min": 1024,
      "max": 128000,
      "zero_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "max"
      ]
    },
    "max_completion_tokens": 64000
  },
  {
    "id": "claude-opus-4-6",
    "thinking": {
      "min": 1024,
      "max": 128000,
      "zero_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-opus-4-7",
    "thinking": {
      "zero_allowed": true,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-opus-4-8",
    "thinking": {
      "zero_allowed": true,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-opus-5",
    "thinking": {
      "zero_allowed": true,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-sonnet-5",
    "thinking": {
      "zero_allowed": true,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-fable-5",
    "thinking": {
      "zero_allowed": false,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-fable-5-1",
    "thinking": {
      "zero_allowed": false,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-opus-5-5",
    "thinking": {
      "zero_allowed": false,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-sonnet-5-5",
    "thinking": {
      "zero_allowed": true,
      "dynamic_allowed": true,
      "disable_type": "between_tools",
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-haiku-5-5",
    "thinking": {
      "zero_allowed": true,
      "dynamic_allowed": true,
      "levels": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "max_completion_tokens": 128000
  },
  {
    "id": "claude-opus-4-5-20251101",
    "thinking": {
      "min": 1024,
      "max": 128000,
      "zero_allowed": true
    },
    "max_completion_tokens": 64000
  },
  {
    "id": "claude-opus-4-1-20250805",
    "thinking": {
      "min": 1024,
      "max": 128000
    },
    "max_completion_tokens": 32000
  },
  {
    "id": "claude-opus-4-20250514",
    "thinking": {
      "min": 1024,
      "max": 128000
    },
    "max_completion_tokens": 32000
  },
  {
    "id": "claude-sonnet-4-20250514",
    "thinking": {
      "min": 1024,
      "max": 128000
    },
    "max_completion_tokens": 64000
  },
  {
    "id": "claude-3-7-sonnet-20250219",
    "thinking": {
      "min": 1024,
      "max": 128000
    },
    "max_completion_tokens": 8192
  },
  {
    "id": "claude-3-5-haiku-20241022",
    "max_completion_tokens": 8192
  }
];
