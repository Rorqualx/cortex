/**
 * Implicit-association test cases for the LongMemEval harness.
 *
 * Inspired by InMind (arXiv:2607.24368): facts that are correctly stored and
 * directly recallable should also surface for *indirect* queries that do not
 * share lexical overlap with the fact text. Each case ingests typed facts
 * into a temporary L3 store, verifies direct recall (sanity), then probes
 * with an indirect query whose tokens barely overlap with the stored fact.
 *
 * The indirect query is expected to score low on BM25 (no lexical overlap)
 * — this is exactly the retrieval blind spot the test is designed to expose.
 * Tests will likely FAIL initially, which is the diagnostic value.
 *
 * Future ARCH-1 (persistent-context routing) should make these pass.
 */

import type { L2Fact, TypedFact } from "./types.js";

export type ImplicitAssociationCase = {
  /** Short identifier for the test case. */
  id: string;
  /** Human-readable description of what the case tests. */
  description: string;
  /** Facts to ingest into the L3 store (prose style). */
  factsToIngest: L2Fact[];
  /** Typed facts to ingest alongside prose facts. */
  typedFactsToIngest?: TypedFact[];
  /** Direct query that lexically matches the fact — sanity check. */
  directQuery: string;
  /** Indirect query that should surface the fact but shares few/no tokens. */
  indirectQuery: string;
  /** Substring that must appear in a returned fact for the case to pass. */
  expectedSubstring: string;
};

/**
 * 12 implicit-association test cases covering health, preference,
 * infrastructure, scheduling, and social-context scenarios.
 *
 * Each case stores a fact that a human would naturally connect to the
 * indirect query, even though the query and fact share almost no vocabulary.
 */
export const IMPLICIT_ASSOCIATION_CASES: ImplicitAssociationCase[] = [
  {
    id: "allergy-almond",
    description: "Tree-nut allergy should surface when recommending almond-based food",
    factsToIngest: [
      {
        id: "f-allergy-1",
        text: "User has a severe tree-nut allergy —walnuts, pecans, almonds, cashews",
        importance: 0.95,
        createdAt: Date.UTC(2026, 6, 1),
        dedupKey: "health:tree_nut_allergy",
        significant: true,
        certainty: "confirmed",
      },
    ],
    directQuery: "What are my allergies?",
    indirectQuery: "Should I try the almond macarons from that bakery?",
    expectedSubstring: "tree-nut allergy",
  },
  {
    id: "server-downtime",
    description: "Pi-hole IP should surface when network is down",
    factsToIngest: [
      {
        id: "f-infra-1",
        text: "Pi-hole DNS server is at 192.168.50.128 and runs unbound",
        importance: 0.8,
        createdAt: Date.UTC(2026, 6, 10),
        dedupKey: "infra:pi_hole",
      },
    ],
    typedFactsToIngest: [
      {
        id: "tf-infra-1",
        slot: "infra:pi_hole_ip",
        value: "192.168.50.128",
        sourceSpan: "Pi-hole DNS server is at 192.168.50.128",
        unit: null,
        confidence: 1.0,
        createdAt: Date.UTC(2026, 6, 10),
      },
    ],
    directQuery: "What is the Pi-hole IP address?",
    indirectQuery: "The internet is down, what should I check first?",
    expectedSubstring: "192.168.50.128",
  },
  {
    id: "timezone-scheduling",
    description: "User timezone should surface for meeting scheduling queries",
    factsToIngest: [
      {
        id: "f-tz-1",
        text: "User lives in Denver, Colorado — Mountain Time (America/Denver)",
        importance: 0.7,
        createdAt: Date.UTC(2026, 5, 15),
        dedupKey: "user:timezone",
      },
    ],
    directQuery: "What timezone am I in?",
    indirectQuery: "Can we do a 9 AM standup with the London team?",
    expectedSubstring: "Mountain Time",
  },
  {
    id: "vegetarian-restaurant",
    description: "Vegetarian diet should surface for restaurant suggestions",
    factsToIngest: [
      {
        id: "f-diet-1",
        text: "User is vegetarian — no meat, poultry, or fish",
        importance: 0.85,
        createdAt: Date.UTC(2026, 6, 5),
        dedupKey: "health:vegetarian",
        significant: true,
        certainty: "confirmed",
      },
    ],
    directQuery: "What is my dietary restriction?",
    indirectQuery: "Let's order from the new BBQ place for dinner",
    expectedSubstring: "vegetarian",
  },
  {
    id: "japanese-language",
    description: "Japanese language study should surface for travel planning",
    factsToIngest: [
      {
        id: "f-lang-1",
        text: "User has been studying Japanese for 6 months and is planning a trip to Tokyo",
        importance: 0.6,
        createdAt: Date.UTC(2026, 4, 20),
        dedupKey: "user:japanese_study",
      },
    ],
    directQuery: "What language am I studying?",
    indirectQuery: "Help me write a packing list for November in Japan",
    expectedSubstring: "Japanese",
  },
  {
    id: "docker-port-conflict",
    description: "Transmission port mapping should surface for container conflicts",
    factsToIngest: [
      {
        id: "f-docker-1",
        text: "Transmission container on HueyTheDestroyer uses port 9091 for the web UI",
        importance: 0.7,
        createdAt: Date.UTC(2026, 6, 12),
        dedupKey: "infra:transmission_port",
      },
    ],
    typedFactsToIngest: [
      {
        id: "tf-docker-1",
        slot: "infra:transmission_port",
        value: "9091",
        sourceSpan: "Transmission container uses port 9091",
        unit: null,
        confidence: 1.0,
        createdAt: Date.UTC(2026, 6, 12),
      },
    ],
    directQuery: "What port does Transmission use?",
    indirectQuery: "I'm getting a port conflict when starting a new container",
    expectedSubstring: "9091",
  },
  {
    id: "rust-stack",
    description: "Rust expertise should surface for performance problem queries",
    factsToIngest: [
      {
        id: "f-stack-1",
        text: "User's primary language is Rust — comfortable with async, traits, and macro metaprogramming",
        importance: 0.65,
        createdAt: Date.UTC(2026, 3, 1),
        dedupKey: "user:rust_expertise",
      },
    ],
    directQuery: "What programming language does the user prefer?",
    indirectQuery: "The parser is spending 40% of its time in the allocator",
    expectedSubstring: "Rust",
  },
  {
    id: "solar-project",
    description: "Underground greenhouse project should surface for insulation questions",
    factsToIngest: [
      {
        id: "f-project-1",
        text: "User is building an underground greenhouse with passive solar heating and earth-sheltered design",
        importance: 0.7,
        createdAt: Date.UTC(2026, 5, 1),
        dedupKey: "project:greenhouse",
      },
    ],
    directQuery: "Tell me about the greenhouse project",
    indirectQuery: "What R-value do I need for below-grade walls?",
    expectedSubstring: "greenhouse",
  },
  {
    id: "budget-constraint",
    description: "Budget limit should surface for purchase recommendations",
    factsToIngest: [
      {
        id: "f-budget-1",
        text: "User set a hard budget cap of $500 for home lab hardware this quarter",
        importance: 0.8,
        createdAt: Date.UTC(2026, 6, 1),
        dedupKey: "budget:home_lab",
        certainty: "instructional",
      },
    ],
    directQuery: "What is my home lab budget?",
    indirectQuery: "The new Synology DS1524+ just dropped, should I get one?",
    expectedSubstring: "500",
  },
  {
    id: "cat-name",
    description: "Pet name should surface for vet-related queries",
    factsToIngest: [
      {
        id: "f-pet-1",
        text: "User has a black cat named Shadow who is 3 years old",
        importance: 0.5,
        createdAt: Date.UTC(2026, 2, 14),
        dedupKey: "pet:cat",
      },
    ],
    directQuery: "What is the cat's name?",
    indirectQuery: "It's time for annual vaccinations",
    expectedSubstring: "Shadow",
  },
  {
    id: "git-workflow",
    description: "Push-to-main workflow should surface for PR-related queries",
    factsToIngest: [
      {
        id: "f-git-1",
        text: "User is sole committer — pushes directly to main, no pull requests or branch ceremonies",
        importance: 0.6,
        createdAt: Date.UTC(2026, 1, 1),
        dedupKey: "workflow:git",
      },
    ],
    directQuery: "What is the git workflow?",
    indirectQuery: "Should I open a PR for this minor config change?",
    expectedSubstring: "main",
  },
  {
    id: "phillips-screwdriver",
    description: "Tool preference should surface for hardware tasks",
    factsToIngest: [
      {
        id: "f-tool-1",
        text: "User prefers Wera tools and only uses Phillips #2 drivers for electronics",
        importance: 0.45,
        createdAt: Date.UTC(2026, 4, 3),
        dedupKey: "preference:tools",
      },
    ],
    directQuery: "What tools does the user prefer?",
    indirectQuery: "I need to open the Fire TV case",
    expectedSubstring: "Wera",
  },
];
