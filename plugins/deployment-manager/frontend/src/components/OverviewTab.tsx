import React, { useState, useCallback } from 'react';
import { Copy, Check, Server, Cpu, Clock, Globe } from 'lucide-react';

interface Deployment {
  id: string;
  name: string;
  providerSlug: string;
  endpointUrl?: string;
  dockerImage: string;
  gpuModel: string;
  gpuVramGb: number;
  gpuCount: number;
  status: string;
  createdAt: string;
  providerDeploymentId?: string;
}

interface OverviewTabProps {
  deployment: Deployment;
}

type Language = 'curl' | 'python' | 'javascript' | 'go';

const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'python', label: 'Python' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'go', label: 'Go' },
];

interface AuthInfo { envVar: string; prefix: string }

function getAuthInfo(providerSlug: string): AuthInfo {
  const map: Record<string, AuthInfo> = {
    runpod:    { envVar: 'RUNPOD_API_KEY',       prefix: 'Bearer' },
    'fal-ai':  { envVar: 'FAL_KEY',              prefix: 'Key' },
    replicate: { envVar: 'REPLICATE_API_TOKEN',  prefix: 'Bearer' },
    baseten:   { envVar: 'BASETEN_API_KEY',      prefix: 'Bearer' },
    modal:     { envVar: 'MODAL_TOKEN_ID',       prefix: 'Bearer' },
  };
  return map[providerSlug] || { envVar: 'API_KEY', prefix: 'Bearer' };
}

function getRunUrl(deployment: Deployment): string {
  if (deployment.providerSlug === 'runpod') {
    if (deployment.endpointUrl) return `${deployment.endpointUrl}/run`;
    if (deployment.providerDeploymentId) return `https://api.runpod.ai/v2/${deployment.providerDeploymentId}/run`;
  }
  return deployment.endpointUrl || 'https://api.example.com/run';
}

function generateSnippet(deployment: Deployment, lang: Language): string {
  const url = getRunUrl(deployment);
  const { envVar, prefix } = getAuthInfo(deployment.providerSlug);
  const body = '{"input": {"prompt": "Hello, world!"}}';
  const isSsh = deployment.providerSlug === 'ssh-bridge' || deployment.providerSlug === 'ssh-compose';
  const authHeader = isSsh ? '' : `${prefix} $${envVar}`;

  switch (lang) {
    case 'curl':
      return isSsh
        ? `curl -X POST "${url}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`
        : `curl -X POST "${url}" \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: ${authHeader}" \\\n  -d '${body}'`;

    case 'python':
      return `import os
import requests

response = requests.post(
    "${url}",
    headers={
        "Content-Type": "application/json",${isSsh ? '' : `\n        "Authorization": f"${prefix} {os.environ['${envVar}']}"`}
    },
    json={"input": {"prompt": "Hello, world!"}}
)

print(response.json())`;

    case 'javascript':
      return `const response = await fetch("${url}", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",${isSsh ? '' : `\n    "Authorization": \`${prefix} \${process.env.${envVar}}\``}
  },
  body: JSON.stringify({ input: { prompt: "Hello, world!" } })
});

const data = await response.json();
console.log(data);`;

    case 'go':
      return `package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"${isSsh ? '' : '\n    "os"'}
)

func main() {
    body, _ := json.Marshal(map[string]interface{}{
        "input": map[string]string{"prompt": "Hello, world!"},
    })

    req, _ := http.NewRequest("POST", "${url}", bytes.NewBuffer(body))
    req.Header.Set("Content-Type", "application/json")${isSsh ? '' : `\n    req.Header.Set("Authorization", "${prefix} "+os.Getenv("${envVar}"))`}

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()
    fmt.Println(resp.Status)
}`;
  }
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ deployment }) => {
  const [selectedLang, setSelectedLang] = useState<Language>('curl');
  const [copied, setCopied] = useState(false);

  const snippet = generateSnippet(deployment, selectedLang);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback: select text */ }
  }, [snippet]);

  return (
    <div>
      {/* Deployment metadata summary */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '0.75rem', marginBottom: '1.5rem',
      }}>
        {[
          { icon: <Globe size={14} />, label: 'Endpoint', value: getRunUrl(deployment) },
          { icon: <Server size={14} />, label: 'Docker Image', value: deployment.dockerImage },
          { icon: <Cpu size={14} />, label: 'GPU', value: `${deployment.gpuModel} (${deployment.gpuVramGb}GB) x${deployment.gpuCount}` },
          { icon: <Clock size={14} />, label: 'Created', value: new Date(deployment.createdAt).toLocaleDateString() },
        ].map((item) => (
          <div key={item.label} style={{
            padding: '0.75rem', background: 'var(--dm-bg-secondary)',
            borderRadius: '0.375rem', fontSize: '0.8rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--dm-text-tertiary)', marginBottom: '0.25rem' }}>
              {item.icon} {item.label}
            </div>
            <div style={{ color: 'var(--dm-text-primary)', fontWeight: 500, wordBreak: 'break-all', fontFamily: item.label === 'Endpoint' ? 'monospace' : 'inherit', fontSize: item.label === 'Endpoint' ? '0.7rem' : '0.8rem' }}>
              {item.value}
            </div>
          </div>
        ))}
      </div>

      {/* Code snippets */}
      <div style={{ marginBottom: '0.75rem' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 0.75rem 0', color: 'var(--dm-text-primary)' }}>
          Quick Start
        </h3>

        <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.75rem' }}>
          {LANGUAGES.map((lang) => (
            <button
              key={lang.id}
              data-testid={`lang-${lang.id}`}
              onClick={() => setSelectedLang(lang.id)}
              style={{
                padding: '0.3rem 0.75rem',
                borderRadius: '1rem',
                fontSize: '0.78rem',
                fontWeight: selectedLang === lang.id ? 600 : 400,
                cursor: 'pointer',
                border: selectedLang === lang.id ? '1.5px solid var(--dm-accent-blue)' : '1px solid var(--dm-border)',
                background: selectedLang === lang.id ? 'var(--dm-accent-blue)' : 'var(--dm-bg-secondary)',
                color: selectedLang === lang.id ? '#fff' : 'var(--dm-text-secondary)',
                transition: 'all 0.15s',
              }}
            >
              {lang.label}
            </button>
          ))}
        </div>

        <div style={{ position: 'relative' }}>
          <pre style={{
            background: '#111827', color: '#e5e7eb',
            fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem',
            padding: '1rem', borderRadius: '0.5rem',
            overflowX: 'auto', lineHeight: 1.7, margin: 0,
          }}>
            {snippet}
          </pre>
          <button
            onClick={handleCopy}
            data-testid="copy-snippet"
            style={{
              position: 'absolute', top: '0.5rem', right: '0.5rem',
              padding: '0.35rem', background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '0.25rem', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '0.25rem',
              color: copied ? '#4ade80' : '#9ca3af', fontSize: '0.7rem',
            }}
          >
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
        </div>
      </div>
    </div>
  );
};
