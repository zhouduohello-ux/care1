export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: "720px", margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1>CareMemory Privacy Policy</h1>
      <p><strong>Last updated:</strong> 15 June 2026</p>

      <h2>1. What we collect</h2>
      <p>
        CareMemory collects patient-reported health information that you choose to share via WhatsApp or other supported channels. This may include symptoms, medication use, activity levels, and other information relevant to your asthma care.
      </p>

      <h2>2. How we use your data</h2>
      <ul>
        <li>To build your personal Disease Card — a structured record of your health between appointments.</li>
        <li>To generate a visit brief that you can share with your clinician before an appointment.</li>
        <li>To remind you to check in and to detect worsening control early.</li>
      </ul>
      <p>We do not use your health data for advertising, model training, or any purpose other than delivering CareMemory to you.</p>

      <h2>3. Your rights under UK GDPR</h2>
      <ul>
        <li><strong>Access:</strong> send EXPORT MY DATA in WhatsApp to receive a copy of your data.</li>
        <li><strong>Deletion:</strong> send DELETE MY DATA at any time to permanently erase your account and all stored records.</li>
        <li><strong>Correction:</strong> contact us if any information is inaccurate.</li>
      </ul>

      <h2>4. Data sharing</h2>
      <p>
        Your health data is not sold or shared with third parties. We share data only when you explicitly choose to share a Brief link or PDF with your healthcare provider.
      </p>

      <h2>5. Security</h2>
      <p>
        Health data is encrypted in transit and stored in a secure database. Access is restricted and audited.
      </p>

      <h2>6. Important disclaimer</h2>
      <p>
        CareMemory is based on patient-reported information only. It is not a diagnosis tool and does not provide medical advice. If you have severe breathing problems, call 999 or follow your asthma action plan.
      </p>

      <h2>7. Contact</h2>
      <p>
        For questions about this policy or your data, contact the CareMemory team at privacy@carememory.example.
      </p>
    </main>
  );
}
