/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/relstate.json`.
 */
export type Relstate = {
  "address": "G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm",
  "metadata": {
    "name": "relstate",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "abandonDispute",
      "docs": [
        "Tenant rejects the proposed deduction with rounds still to spare; the deposit returns in",
        "full and the landlord may propose once more."
      ],
      "discriminator": [
        51,
        248,
        79,
        178,
        3,
        240,
        74,
        145
      ],
      "accounts": [
        {
          "name": "tenant",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "acceptDeduction",
      "docs": [
        "Tenant accepts the landlord's proposed deduction as it stands."
      ],
      "discriminator": [
        75,
        130,
        220,
        51,
        114,
        56,
        225,
        189
      ],
      "accounts": [
        {
          "name": "tenant",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "apply",
      "discriminator": [
        248,
        243,
        145,
        24,
        105,
        50,
        162,
        225
      ],
      "accounts": [
        {
          "name": "tenant",
          "writable": true,
          "signer": true
        },
        {
          "name": "listing"
        },
        {
          "name": "application",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  112,
                  112,
                  108,
                  105,
                  99,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "listing"
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "attestation",
          "docs": [
            "for it. An unverified wallet has nothing here at all, so it is read by hand in the handler",
            "and a missing account is reported as `KycRequired` rather than as a broken account list."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "attest",
      "discriminator": [
        83,
        148,
        120,
        119,
        144,
        139,
        117,
        160
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the attestation account's rent and the transaction fee. Separate from `issuer` so the",
            "backend's sponsor key can fund the write while only the issuer key authorises it; passing",
            "the same key for both is allowed, it simply means that key does both jobs."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "wallet",
          "docs": [
            "field — so it needs no type and never signs: KYC is granted *to* a wallet, not asked for",
            "by one."
          ]
        },
        {
          "name": "attestation",
          "docs": [
            "Init-or-update, so re-verifying a wallet (a new level, a fresh expiry, or a comeback after",
            "a revocation) is the same instruction as verifying it the first time. The seeds pin it to",
            "`wallet`, and every field is overwritten below, so there is nothing a second call can",
            "leave half-set."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "level",
          "type": "u8"
        },
        {
          "name": "expiresAt",
          "type": "i64"
        },
        {
          "name": "subjectHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "claimDeposit",
      "discriminator": [
        201,
        106,
        1,
        224,
        122,
        144,
        210,
        155
      ],
      "accounts": [
        {
          "name": "tenant",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "closeApplication",
      "discriminator": [
        185,
        123,
        65,
        93,
        138,
        249,
        205,
        150
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "application",
          "writable": true
        },
        {
          "name": "tenant",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "closeListing",
      "discriminator": [
        33,
        15,
        192,
        81,
        78,
        175,
        159,
        97
      ],
      "accounts": [
        {
          "name": "landlord",
          "writable": true,
          "signer": true,
          "relations": [
            "listing"
          ]
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              },
              {
                "kind": "account",
                "path": "listing.listingId",
                "account": "listing"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "confirmAppraiserKey",
      "docs": [
        "The party that did not propose, phase 2: confirms the same wallet and binds it."
      ],
      "discriminator": [
        143,
        44,
        43,
        2,
        53,
        118,
        194,
        242
      ],
      "accounts": [
        {
          "name": "party",
          "signer": true
        },
        {
          "name": "lease",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          },
          "relations": [
            "dispute"
          ]
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "wallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "createListing",
      "discriminator": [
        18,
        168,
        45,
        24,
        191,
        31,
        117,
        54
      ],
      "accounts": [
        {
          "name": "landlord",
          "writable": true,
          "signer": true
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              },
              {
                "kind": "arg",
                "path": "listingId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "listingId",
          "type": "u64"
        },
        {
          "name": "rentAmount",
          "type": "u64"
        },
        {
          "name": "depositAmount",
          "type": "u64"
        },
        {
          "name": "region",
          "type": {
            "array": [
              "u8",
              2
            ]
          }
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "city",
          "type": "string"
        },
        {
          "name": "blurb",
          "type": "string"
        },
        {
          "name": "photo",
          "type": "string"
        }
      ]
    },
    {
      "name": "escalateToMediation",
      "docs": [
        "Tenant rejects for the last time: the lease enters `Mediation` and an appraiser decides (D2)."
      ],
      "discriminator": [
        222,
        169,
        55,
        133,
        249,
        127,
        81,
        196
      ],
      "accounts": [
        {
          "name": "tenant",
          "writable": true,
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "dispute",
          "docs": [
            "Paid for by the tenant and returned to them on whichever exit ends the mediation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "expireMediation",
      "docs": [
        "Landlord or tenant: past the selection deadline with nothing bound, or past the verdict",
        "deadline once bound. The lease returns to `Active` and the claim clock resumes."
      ],
      "discriminator": [
        197,
        47,
        239,
        162,
        124,
        163,
        62,
        49
      ],
      "accounts": [
        {
          "name": "party",
          "signer": true
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          },
          "relations": [
            "dispute"
          ]
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenant",
          "docs": [
            "The rent destination, pinned to the lease's tenant: whichever party calls this, the refund",
            "goes to whoever paid for the account."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "finalizeDeduction",
      "docs": [
        "Landlord closes an unanswered dispute once the tenant's window has passed."
      ],
      "discriminator": [
        44,
        205,
        26,
        16,
        245,
        128,
        224,
        6
      ],
      "accounts": [
        {
          "name": "landlord",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.tenant",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "fundDeposit",
      "discriminator": [
        149,
        24,
        209,
        94,
        206,
        202,
        144,
        233
      ],
      "accounts": [
        {
          "name": "tenant",
          "writable": true,
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "attestation",
          "docs": [
            "because an unverified wallet has no account here (see `apply`)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "leaseHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initConfig",
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "markDefault",
      "discriminator": [
        182,
        231,
        123,
        132,
        66,
        208,
        137,
        139
      ],
      "accounts": [
        {
          "name": "landlord",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.tenant",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "docs": [
            "Added so a seizure lands on the landlord's own record too. Without it a landlord who",
            "defaults every tenant and keeps their deposits showed a spotless return history, which made",
            "the return rate gameable (A1 in the plan). Created by `propose_lease`, so it always exists."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "payRent",
      "discriminator": [
        69,
        155,
        112,
        183,
        178,
        234,
        94,
        100
      ],
      "accounts": [
        {
          "name": "tenant",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "instructions",
          "docs": [
            "rent on a confidential mint. Pinned by address, and unused on a public mint."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "pickAppraiser",
      "docs": [
        "Landlord or tenant, phase 1: names one company from either list. Matching picks agree it."
      ],
      "discriminator": [
        199,
        118,
        216,
        137,
        117,
        10,
        136,
        185
      ],
      "accounts": [
        {
          "name": "party",
          "signer": true
        },
        {
          "name": "lease",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          },
          "relations": [
            "dispute"
          ]
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    {
      "name": "proposeAppraiserKey",
      "docs": [
        "Landlord or tenant, phase 2: proposes the wallet that signs for the agreed company."
      ],
      "discriminator": [
        111,
        42,
        28,
        193,
        176,
        235,
        55,
        61
      ],
      "accounts": [
        {
          "name": "party",
          "signer": true
        },
        {
          "name": "lease",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          },
          "relations": [
            "dispute"
          ]
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "wallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "proposeAppraisers",
      "docs": [
        "Landlord or tenant, phase 1: nominates one to three appraisal companies by name, each with",
        "a fee. Once per side."
      ],
      "discriminator": [
        221,
        98,
        9,
        59,
        134,
        59,
        96,
        67
      ],
      "accounts": [
        {
          "name": "party",
          "signer": true
        },
        {
          "name": "lease",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          },
          "relations": [
            "dispute"
          ]
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "candidates",
          "type": {
            "vec": {
              "defined": {
                "name": "candidateInput"
              }
            }
          }
        }
      ]
    },
    {
      "name": "proposeLease",
      "discriminator": [
        244,
        160,
        116,
        78,
        18,
        152,
        175,
        148
      ],
      "accounts": [
        {
          "name": "landlord",
          "writable": true,
          "signer": true
        },
        {
          "name": "tenant"
        },
        {
          "name": "tenantProfile",
          "docs": [
            "account. It may not exist yet (first-time tenant), so it is read by hand in the handler."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "attestation",
          "docs": [
            "because an unverified wallet has no account here (see `apply`)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              },
              {
                "kind": "arg",
                "path": "leaseId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "leaseId",
          "type": "u64"
        },
        {
          "name": "rentAmount",
          "type": "u64"
        },
        {
          "name": "standardDeposit",
          "type": "u64"
        },
        {
          "name": "periodSecs",
          "type": "i64"
        },
        {
          "name": "graceSecs",
          "type": "i64"
        },
        {
          "name": "termPeriods",
          "type": "u16"
        },
        {
          "name": "leaseHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "region",
          "type": {
            "array": [
              "u8",
              2
            ]
          }
        }
      ]
    },
    {
      "name": "releaseDeposit",
      "discriminator": [
        64,
        87,
        121,
        32,
        104,
        72,
        160,
        185
      ],
      "accounts": [
        {
          "name": "landlord",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.tenant",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "deduction",
          "type": "u64"
        }
      ]
    },
    {
      "name": "revoke",
      "discriminator": [
        170,
        23,
        31,
        34,
        133,
        173,
        93,
        242
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "wallet"
        },
        {
          "name": "attestation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "setAdmin",
      "discriminator": [
        251,
        163,
        0,
        52,
        91,
        194,
        187,
        92
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setIssuer",
      "discriminator": [
        122,
        240,
        209,
        127,
        179,
        164,
        175,
        206
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "issuer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setMintAllowed",
      "discriminator": [
        245,
        141,
        124,
        184,
        161,
        169,
        177,
        171
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "The mint being allowed or removed. On allow it is inspected for extensions that would",
            "break the escrow arithmetic or disable the confidential-transfer privacy mitigation."
          ]
        }
      ],
      "args": [
        {
          "name": "allowed",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setRequireKyc",
      "discriminator": [
        34,
        245,
        213,
        202,
        112,
        243,
        32,
        15
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "required",
          "type": "bool"
        }
      ]
    },
    {
      "name": "settleDispute",
      "docs": [
        "Both parties sign a final deduction and the lease closes on it (D1)."
      ],
      "discriminator": [
        155,
        147,
        5,
        44,
        20,
        204,
        146,
        43
      ],
      "accounts": [
        {
          "name": "tenant",
          "writable": true,
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "landlord",
          "signer": true,
          "relations": [
            "lease"
          ]
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          },
          "relations": [
            "dispute"
          ]
        },
        {
          "name": "dispute",
          "docs": [
            "Required in `Mediation`, where it is closed and its rent returned to the tenant who paid",
            "for it; must be absent in `Disputed`."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "tenant"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "landlord"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "deduction",
          "type": "u64"
        }
      ]
    },
    {
      "name": "submitVerdict",
      "docs": [
        "The bound appraiser decides the deduction; the deposit is split and the lease closes."
      ],
      "discriminator": [
        138,
        102,
        56,
        22,
        229,
        130,
        105,
        118
      ],
      "accounts": [
        {
          "name": "appraiser",
          "signer": true
        },
        {
          "name": "lease",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  97,
                  115,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              },
              {
                "kind": "account",
                "path": "lease.leaseId",
                "account": "lease"
              }
            ]
          },
          "relations": [
            "dispute"
          ]
        },
        {
          "name": "dispute",
          "docs": [
            "Closed here, with the rent going back to the tenant who paid for it in",
            "`escalate_to_mediation`. Closing it is also what makes \"one verdict per dispute\" structural",
            "rather than a flag: there is no account left to submit against."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "lease"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lease"
              }
            ]
          }
        },
        {
          "name": "tenant",
          "docs": [
            "The rent destination for the closed `Dispute`, pinned to the lease's tenant so the",
            "appraiser cannot redirect it. Not a signer: the tenant does not have to be present for",
            "their own refund."
          ],
          "writable": true
        },
        {
          "name": "tenantAta",
          "writable": true
        },
        {
          "name": "landlordAta",
          "writable": true
        },
        {
          "name": "appraiserAta",
          "docs": [
            "Where the fee goes. Pinned to the signing appraiser, so a verdict cannot pay the fee",
            "anywhere else. Must already exist: the client puts an idempotent create-associated-token-",
            "account instruction, paid by the sponsor, before `submit_verdict` in the same transaction",
            "(docs §4). A missing one fails here, loudly, and nothing moves."
          ],
          "writable": true
        },
        {
          "name": "tenantProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.tenant",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "landlordProfile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  102,
                  105,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "lease.landlord",
                "account": "lease"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "deduction",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "application",
      "discriminator": [
        219,
        9,
        27,
        113,
        208,
        126,
        203,
        30
      ]
    },
    {
      "name": "attestation",
      "discriminator": [
        152,
        125,
        183,
        86,
        36,
        146,
        121,
        73
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "dispute",
      "discriminator": [
        36,
        49,
        241,
        67,
        40,
        36,
        241,
        74
      ]
    },
    {
      "name": "lease",
      "discriminator": [
        14,
        103,
        218,
        61,
        248,
        234,
        105,
        84
      ]
    },
    {
      "name": "listing",
      "discriminator": [
        218,
        32,
        50,
        73,
        43,
        134,
        26,
        58
      ]
    },
    {
      "name": "profile",
      "discriminator": [
        184,
        101,
        165,
        188,
        95,
        63,
        127,
        188
      ]
    }
  ],
  "events": [
    {
      "name": "appraiserBound",
      "discriminator": [
        207,
        59,
        93,
        1,
        155,
        194,
        142,
        242
      ]
    },
    {
      "name": "appraiserKeyProposed",
      "discriminator": [
        76,
        81,
        165,
        186,
        91,
        158,
        77,
        17
      ]
    },
    {
      "name": "appraiserNameAgreed",
      "discriminator": [
        75,
        238,
        169,
        164,
        63,
        2,
        69,
        109
      ]
    },
    {
      "name": "appraiserPicked",
      "discriminator": [
        86,
        245,
        240,
        153,
        138,
        216,
        217,
        244
      ]
    },
    {
      "name": "appraisersProposed",
      "discriminator": [
        111,
        201,
        46,
        210,
        103,
        133,
        64,
        75
      ]
    },
    {
      "name": "attestationRevoked",
      "discriminator": [
        47,
        106,
        65,
        238,
        200,
        127,
        163,
        50
      ]
    },
    {
      "name": "attested",
      "discriminator": [
        184,
        102,
        113,
        199,
        220,
        197,
        96,
        50
      ]
    },
    {
      "name": "depositDisputeRejected",
      "discriminator": [
        212,
        244,
        207,
        79,
        75,
        229,
        14,
        224
      ]
    },
    {
      "name": "depositDisputed",
      "discriminator": [
        35,
        249,
        16,
        66,
        47,
        238,
        27,
        11
      ]
    },
    {
      "name": "leaseClosed",
      "discriminator": [
        75,
        156,
        130,
        204,
        31,
        95,
        218,
        182
      ]
    },
    {
      "name": "leaseDefaulted",
      "discriminator": [
        226,
        7,
        17,
        172,
        211,
        133,
        104,
        214
      ]
    },
    {
      "name": "mediationExpired",
      "discriminator": [
        184,
        31,
        219,
        126,
        84,
        141,
        84,
        134
      ]
    },
    {
      "name": "mediationOpened",
      "discriminator": [
        154,
        44,
        69,
        30,
        228,
        255,
        77,
        142
      ]
    },
    {
      "name": "mediationVerdict",
      "discriminator": [
        17,
        102,
        206,
        121,
        57,
        255,
        102,
        224
      ]
    },
    {
      "name": "rentPaid",
      "discriminator": [
        140,
        29,
        172,
        69,
        152,
        38,
        73,
        241
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "wrongStatus",
      "msg": "Lease is not in the required status"
    },
    {
      "code": 6001,
      "name": "termCompleted",
      "msg": "All rent periods are already paid"
    },
    {
      "code": 6002,
      "name": "termIncomplete",
      "msg": "Rent periods are still unpaid"
    },
    {
      "code": 6003,
      "name": "deductionTooLarge",
      "msg": "Deduction is larger than deposit"
    },
    {
      "code": 6004,
      "name": "zeroRent",
      "msg": "Rent must be greater than zero"
    },
    {
      "code": 6005,
      "name": "zeroTerm",
      "msg": "Lease needs at least one rent period"
    },
    {
      "code": 6006,
      "name": "periodTooShort",
      "msg": "Rent period is shorter than the minimum"
    },
    {
      "code": 6007,
      "name": "selfLease",
      "msg": "Landlord and tenant must be different wallets"
    },
    {
      "code": 6008,
      "name": "invalidGrace",
      "msg": "Grace must be between zero and one period"
    },
    {
      "code": 6009,
      "name": "notInDefault",
      "msg": "Rent is not overdue long enough to declare a default"
    },
    {
      "code": 6010,
      "name": "claimTooEarly",
      "msg": "The landlord still has time to release the deposit"
    },
    {
      "code": 6011,
      "name": "leaseHashMismatch",
      "msg": "Lease hash does not match the proposed lease"
    },
    {
      "code": 6012,
      "name": "tooEarly",
      "msg": "This rent period is not due yet"
    },
    {
      "code": 6013,
      "name": "leaseNotEnded",
      "msg": "The lease term has not ended yet"
    },
    {
      "code": 6014,
      "name": "mintNotAllowed",
      "msg": "Mint is not allowed for leases"
    },
    {
      "code": 6015,
      "name": "invalidRegion",
      "msg": "Region must be two uppercase letters (ISO country code)"
    },
    {
      "code": 6016,
      "name": "textTooLong",
      "msg": "Listing text is too long"
    },
    {
      "code": 6017,
      "name": "notYourApplication",
      "msg": "Only the applicant or the landlord can close an application"
    },
    {
      "code": 6018,
      "name": "notAdmin",
      "msg": "Only the config admin can change the program settings"
    },
    {
      "code": 6019,
      "name": "mintListFull",
      "msg": "The allowed-mint list is full"
    },
    {
      "code": 6020,
      "name": "invalidMintData",
      "msg": "The mint account could not be read"
    },
    {
      "code": 6021,
      "name": "missingConfidentialTransfer",
      "msg": "Paying rent on a confidential mint needs a matching Token-2022 confidential transfer directly before pay_rent"
    },
    {
      "code": 6022,
      "name": "confidentialMintNeedsAuditor",
      "msg": "A confidential-transfer mint must carry an auditor ElGamal pubkey to be allowed"
    },
    {
      "code": 6023,
      "name": "disallowedMintExtension",
      "msg": "The mint carries an extension that is not allowed for leases"
    },
    {
      "code": 6024,
      "name": "invalidNewAdmin",
      "msg": "The new admin must not be the default (all-zero) pubkey"
    },
    {
      "code": 6025,
      "name": "kycRequired",
      "msg": "This wallet needs a valid identity attestation (level 1 or higher, not revoked, not expired)"
    },
    {
      "code": 6026,
      "name": "notIssuer",
      "msg": "Only the issuer key in the program config can write or revoke an attestation"
    },
    {
      "code": 6027,
      "name": "issuerNotSet",
      "msg": "No attestation issuer is set in the program config"
    },
    {
      "code": 6028,
      "name": "invalidIssuer",
      "msg": "The issuer must not be the default (all-zero) pubkey"
    },
    {
      "code": 6029,
      "name": "invalidAttestationLevel",
      "msg": "An attestation must be level 1 (basic) or 2 (enhanced)"
    },
    {
      "code": 6030,
      "name": "attestationExpiryInPast",
      "msg": "An attestation's expiry must be in the future, or zero for never"
    },
    {
      "code": 6031,
      "name": "invalidSubjectHash",
      "msg": "An attestation needs a non-zero subject hash"
    },
    {
      "code": 6032,
      "name": "disputeWindowOpen",
      "msg": "The tenant still has time to answer the proposed deduction"
    },
    {
      "code": 6033,
      "name": "disputeWindowClosed",
      "msg": "The window to reject the proposed deduction has passed"
    },
    {
      "code": 6034,
      "name": "disputeRoundsExhausted",
      "msg": "No dispute rounds are left on this lease, so the deposit returns in full"
    },
    {
      "code": 6035,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6036,
      "name": "zeroDeposit",
      "msg": "The deposit must be greater than zero"
    },
    {
      "code": 6037,
      "name": "termTooLong",
      "msg": "The lease term (periods x period length) is too long"
    },
    {
      "code": 6038,
      "name": "notMediationParty",
      "msg": "Only the landlord or the tenant of this lease can do that"
    },
    {
      "code": 6039,
      "name": "wrongDisputeRound",
      "msg": "Wrong dispute round for this instruction: reject with abandon_dispute until the last round, then with escalate_to_mediation"
    },
    {
      "code": 6040,
      "name": "appraiserAlreadyBound",
      "msg": "An appraiser is already bound to this dispute"
    },
    {
      "code": 6041,
      "name": "appraiserNotBound",
      "msg": "No appraiser is bound to this dispute yet"
    },
    {
      "code": 6042,
      "name": "notBoundAppraiser",
      "msg": "Only the appraiser bound to this dispute can submit the verdict"
    },
    {
      "code": 6043,
      "name": "candidatesAlreadyProposed",
      "msg": "This side has already proposed its appraisers"
    },
    {
      "code": 6044,
      "name": "duplicateCandidate",
      "msg": "The same appraiser company was proposed twice"
    },
    {
      "code": 6045,
      "name": "candidateNotProposed",
      "msg": "That appraiser company was not proposed by either side"
    },
    {
      "code": 6046,
      "name": "selectionWindowOpen",
      "msg": "Nothing is bound yet and the selection window is still open"
    },
    {
      "code": 6047,
      "name": "verdictWindowOpen",
      "msg": "The appraiser still has time to submit a verdict"
    },
    {
      "code": 6048,
      "name": "verdictWindowClosed",
      "msg": "The window for the appraiser's verdict has passed"
    },
    {
      "code": 6049,
      "name": "disputeAccountRequired",
      "msg": "Settling a lease in mediation needs its dispute account"
    },
    {
      "code": 6050,
      "name": "unexpectedDisputeAccount",
      "msg": "This lease has no dispute account to pass"
    },
    {
      "code": 6051,
      "name": "selectionWindowClosed",
      "msg": "The selection window has closed, so the mediation can be expired"
    },
    {
      "code": 6052,
      "name": "invalidAppraiserName",
      "msg": "An appraiser name must be 1-64 bytes of UTF-8 without control characters"
    },
    {
      "code": 6053,
      "name": "noCandidates",
      "msg": "Propose between one and three appraiser candidates"
    },
    {
      "code": 6054,
      "name": "feeAboveCap",
      "msg": "The appraiser fee is above a tenth of the deposit"
    },
    {
      "code": 6055,
      "name": "nameAlreadyAgreed",
      "msg": "The appraiser company is already agreed"
    },
    {
      "code": 6056,
      "name": "nameNotAgreed",
      "msg": "The two sides have not agreed on an appraiser company yet"
    },
    {
      "code": 6057,
      "name": "invalidAppraiserKey",
      "msg": "An appraiser's wallet must not be the default (all-zero) pubkey"
    },
    {
      "code": 6058,
      "name": "keyProposalsExhausted",
      "msg": "No more appraiser wallet proposals are allowed; confirm the last one or let the mediation expire"
    },
    {
      "code": 6059,
      "name": "noKeyProposed",
      "msg": "No appraiser wallet has been proposed"
    },
    {
      "code": 6060,
      "name": "cannotConfirmOwnProposal",
      "msg": "The other party must confirm the appraiser wallet"
    },
    {
      "code": 6061,
      "name": "keyMismatch",
      "msg": "That is not the appraiser wallet that was proposed"
    }
  ],
  "types": [
    {
      "name": "application",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "landlord",
            "type": "pubkey"
          },
          {
            "name": "tenant",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "appraiserBound",
      "docs": [
        "Both parties confirmed the wallet: an appraiser is bound and the verdict window has started."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "appraiser",
            "type": "pubkey"
          },
          {
            "name": "nameHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "verdictDeadline",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "appraiserKeyProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "party",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "proposals",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "appraiserNameAgreed",
      "docs": [
        "Both sides picked the same company; the fee is the lowest anyone proposed for it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "nameHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "appraiserPicked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "party",
            "type": "pubkey"
          },
          {
            "name": "nameHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "appraisersProposed",
      "docs": [
        "One side nominated its candidates. The names are on the `Dispute` account; the event carries",
        "only who acted and how many, so the app knows to refetch."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "party",
            "type": "pubkey"
          },
          {
            "name": "count",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "attestation",
      "docs": [
        "One wallet's KYC result, written only by the issuer key. Seeds `[ATTESTATION_SEED, wallet]`.",
        "",
        "No personal data lives here and none ever should: the only link back to the applicant is",
        "`subject_hash`, which the backend computes as `sha256(applicant_id || salt)` with a salt it",
        "never publishes (docs/privacy.md). The chain therefore proves *that* a wallet passed a check",
        "at a point in time, and nothing about who it belongs to."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "issuer",
            "docs": [
              "The issuer at the time of signing. Compared against `Config::issuer` on every check, so",
              "rotating the issuer invalidates everything the old key vouched for."
            ],
            "type": "pubkey"
          },
          {
            "name": "level",
            "docs": [
              "0 none (never stored), 1 basic, 2 enhanced."
            ],
            "type": "u8"
          },
          {
            "name": "verifiedAt",
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Unix seconds; 0 means it never expires. The demo issues one year."
            ],
            "type": "i64"
          },
          {
            "name": "revoked",
            "type": "bool"
          },
          {
            "name": "subjectHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "attestationRevoked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "attested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "level",
            "type": "u8"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "candidate",
      "docs": [
        "One appraisal company a party proposed. The name is the display form; `name_hash` is what is",
        "compared (docs/contracts/dispute-mediation.md §4)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "name",
            "docs": [
              "Only `[..name_len]` is meaningful; the rest is zero padding."
            ],
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "nameLen",
            "type": "u8"
          },
          {
            "name": "nameHash",
            "docs": [
              "`sha256(canonical(name))`, the only thing two names are compared by."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "fee",
            "docs": [
              "Base units of the lease mint, at most `deposit / APPRAISER_FEE_CAP_DIVISOR` when proposed."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "candidateInput",
      "docs": [
        "One proposed company, as the client sends it. Normalised and hashed by `Candidate::new`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Program-wide settings, one account at seeds `[CONFIG_SEED]`. Holds the mints a lease may be",
        "denominated in: whoever runs `init_config` on a fresh network becomes the admin that edits it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "mints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "issuer",
            "docs": [
              "The only key `attest` and `revoke` accept as a signer. Deliberately **not** the fee payer",
              "key: a leaked sponsor key must not be able to mint identity (docs/contracts/attestation.md).",
              "All-zero means no issuer has been set, and `require_kyc` cannot be turned on without one."
            ],
            "type": "pubkey"
          },
          {
            "name": "requireKyc",
            "docs": [
              "Whether `apply` and `propose_lease` demand a valid attestation from the acting wallet.",
              "False by default, which is what keeps a fresh network (and the test suite) usable before",
              "any KYC exists; the devnet demo deploy turns it on."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "depositDisputeRejected",
      "docs": [
        "The tenant rejected the proposal. The deposit now returns in full, through `claim_deposit`",
        "once the resumed clock runs out, or sooner if the landlord releases it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "claimDeadline",
            "type": "i64"
          },
          {
            "name": "disputeRounds",
            "docs": [
              "How many rejections this lease has now had. At `MAX_DISPUTE_ROUNDS` the landlord can no",
              "longer propose a deduction, which is why this is on the event the app listens to."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "depositDisputed",
      "docs": [
        "The landlord proposed a deduction and the lease is waiting on the tenant. No money moved."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "proposedDeduction",
            "type": "u64"
          },
          {
            "name": "answerBy",
            "docs": [
              "When the tenant's window to answer runs out."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "dispute",
      "docs": [
        "Everything mediation-specific, at seeds `[DISPUTE_SEED, lease]`. Created by",
        "`escalate_to_mediation` and closed on every exit, with the rent going back to the tenant who",
        "paid for it, so it exists exactly while the lease is in `Mediation`.",
        "",
        "`Lease` gains nothing for mediation: the audited, money-bearing account keeps its 218-byte",
        "layout and the new surface is all here. There is no appraiser registry: everything the program",
        "knows about the appraiser is on this account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "docs": [
              "Redundant with the seeds; kept so every instruction can assert `has_one = lease`."
            ],
            "type": "pubkey"
          },
          {
            "name": "landlordCandidates",
            "docs": [
              "Only `[..landlord_count]` is meaningful; the rest is `Candidate::EMPTY`."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "candidate"
                  }
                },
                3
              ]
            }
          },
          {
            "name": "tenantCandidates",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "candidate"
                  }
                },
                3
              ]
            }
          },
          {
            "name": "landlordCount",
            "type": "u8"
          },
          {
            "name": "tenantCount",
            "type": "u8"
          },
          {
            "name": "landlordPick",
            "docs": [
              "`name_hash` of the pick; all-zero until that side picks. A side may change its pick until",
              "the company is agreed."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tenantPick",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "agreedNameHash",
            "docs": [
              "All-zero until both picks name the same company."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "agreedFee",
            "docs": [
              "The lower of the fees proposed for the agreed company."
            ],
            "type": "u64"
          },
          {
            "name": "proposedKey",
            "docs": [
              "The wallet one party proposed for the agreed company; all-zero until proposed."
            ],
            "type": "pubkey"
          },
          {
            "name": "keyProposer",
            "docs": [
              "Which party made the current proposal; only the other one may confirm it."
            ],
            "type": "pubkey"
          },
          {
            "name": "keyProposals",
            "type": "u8"
          },
          {
            "name": "appraiser",
            "docs": [
              "The bound wallet, all-zero until `confirm_appraiser_key`. Cannot collide with \"unset\":",
              "`propose_appraiser_key` refuses the all-zero key."
            ],
            "type": "pubkey"
          },
          {
            "name": "selectionDeadline",
            "docs": [
              "Nothing may be proposed, picked or bound at or after this, and an unbound mediation may be",
              "expired from then on."
            ],
            "type": "i64"
          },
          {
            "name": "verdictDeadline",
            "docs": [
              "0 until bound; then `bound_at + VERDICT_WINDOW_SECS`. Only a binding writes it."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "lease",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "landlord",
            "type": "pubkey"
          },
          {
            "name": "tenant",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "leaseId",
            "type": "u64"
          },
          {
            "name": "rentAmount",
            "type": "u64"
          },
          {
            "name": "depositAmount",
            "type": "u64"
          },
          {
            "name": "startTs",
            "type": "i64"
          },
          {
            "name": "termPeriods",
            "type": "u16"
          },
          {
            "name": "paidCount",
            "type": "u16"
          },
          {
            "name": "leaseHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "status"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "periodSecs",
            "type": "i64"
          },
          {
            "name": "graceSecs",
            "type": "i64"
          },
          {
            "name": "region",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "discountPct",
            "type": "u8"
          },
          {
            "name": "proposedDeduction",
            "docs": [
              "The deduction the landlord asked for when the lease entered `Disputed`. It is a proposal,",
              "not a decision: no money moves until it is accepted, finalized or settled. Zeroed on every",
              "exit from `Disputed`."
            ],
            "type": "u64"
          },
          {
            "name": "disputedAt",
            "docs": [
              "When the current dispute **or** mediation started; 0 when the lease is neither.",
              "`DISPUTE_WINDOW_SECS` runs from here while `Disputed`, and `escalate_to_mediation` re-stamps",
              "it so the same field times the `Mediation` stretch. Deliberately the only copy of that",
              "timestamp: `Dispute` does not repeat it, because the claim-pause arithmetic below must have",
              "exactly one source of truth."
            ],
            "type": "i64"
          },
          {
            "name": "claimPauseSecs",
            "docs": [
              "Total seconds this lease has spent inside a dispute, added to the claim deadline. This is",
              "what makes a rejected dispute *resume* the `claim_deposit` clock instead of restarting it,",
              "and it is why a landlord cannot shorten the tenant's claim by opening one."
            ],
            "type": "i64"
          },
          {
            "name": "disputeRounds",
            "docs": [
              "How many proposed deductions the tenant has rejected, capped at `MAX_DISPUTE_ROUNDS`. Each",
              "rejection voids that proposal; the landlord may propose again while rounds are left, and",
              "the last rejection escalates to `Status::Mediation` instead. At the cap `release_deposit`",
              "refuses any deduction, which is what stops a landlord re-disputing every time the resumed",
              "claim clock comes due and keeping the deposit out of reach forever. `release_deposit(0)`",
              "works throughout, so a full return is always open.",
              "",
              "**This byte was `dispute_rejected: bool`** in the deployed program, at the same offset",
              "(217) and with the same encoding for 0 and 1, so an existing lease upgrades in place and",
              "reads as 0 or 1 rounds. The upgrade is one-way: a lease that reaches 2 stores `0x02`, which",
              "the old program would reject as an invalid bool. docs/contracts/dispute-mediation.md §8."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "leaseClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "deduction",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "leaseDefaulted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "seized",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "listing",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "landlord",
            "type": "pubkey"
          },
          {
            "name": "listingId",
            "type": "u64"
          },
          {
            "name": "rentAmount",
            "type": "u64"
          },
          {
            "name": "depositAmount",
            "type": "u64"
          },
          {
            "name": "region",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "title",
            "type": "string"
          },
          {
            "name": "city",
            "type": "string"
          },
          {
            "name": "blurb",
            "type": "string"
          },
          {
            "name": "photo",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "mediationExpired",
      "docs": [
        "Nobody submitted a verdict in time. The lease is `Active` again and the deposit comes back to",
        "the tenant through the resumed claim clock."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "claimDeadline",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "mediationOpened",
      "docs": [
        "The tenant used the last dispute round: the number is now an appraiser's to decide."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "dispute",
            "type": "pubkey"
          },
          {
            "name": "selectionDeadline",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "mediationVerdict",
      "docs": [
        "The appraiser decided. `LeaseClosed` is emitted alongside it by the shared payout path."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "appraiser",
            "type": "pubkey"
          },
          {
            "name": "deduction",
            "type": "u64"
          },
          {
            "name": "feePaid",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "profile",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "leasesCompleted",
            "type": "u32"
          },
          {
            "name": "paidOnTime",
            "type": "u32"
          },
          {
            "name": "paidLate",
            "type": "u32"
          },
          {
            "name": "depositsReturnedFull",
            "type": "u32"
          },
          {
            "name": "depositTotal",
            "type": "u64"
          },
          {
            "name": "deductedTotal",
            "type": "u64"
          },
          {
            "name": "defaults",
            "type": "u32"
          },
          {
            "name": "depositsClaimed",
            "type": "u32"
          },
          {
            "name": "rentPaidTotal",
            "type": "u64"
          },
          {
            "name": "lastDepositReturnBps",
            "docs": [
              "How much of the most recent closed deposit went back to the tenant, in basis points",
              "(`BPS_FULL` = all of it). 0 also reads as \"no deposit outcome yet\", which `deposit_events`",
              "tells apart."
            ],
            "type": "u16"
          },
          {
            "name": "depositEvents",
            "docs": [
              "How many leases reached a deposit outcome — release, settlement, claim or default. The",
              "denominator behind \"returns X% of deposits over N leases\", and the confidence in the rate:",
              "one lease at 100% says much less than twenty."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "rentPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lease",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u16"
          },
          {
            "name": "onTime",
            "type": "bool"
          },
          {
            "name": "confidential",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "status",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "proposed"
          },
          {
            "name": "active"
          },
          {
            "name": "closed"
          },
          {
            "name": "defaulted"
          },
          {
            "name": "disputed"
          },
          {
            "name": "mediation"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "applicationSeed",
      "type": "bytes",
      "value": "[97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110]"
    },
    {
      "name": "appraiserFeeCapDivisor",
      "type": "u64",
      "value": "10"
    },
    {
      "name": "attestationSeed",
      "type": "bytes",
      "value": "[97, 116, 116, 101, 115, 116, 97, 116, 105, 111, 110]"
    },
    {
      "name": "bpsFull",
      "type": "u16",
      "value": "10000"
    },
    {
      "name": "claimWindowSecs",
      "type": "i64",
      "value": "3"
    },
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "disputeSeed",
      "type": "bytes",
      "value": "[100, 105, 115, 112, 117, 116, 101]"
    },
    {
      "name": "disputeWindowSecs",
      "type": "i64",
      "value": "45"
    },
    {
      "name": "goodStandingDiscountPct",
      "type": "u8",
      "value": "50"
    },
    {
      "name": "kycLevelBasic",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "kycLevelEnhanced",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "leaseSeed",
      "type": "bytes",
      "value": "[108, 101, 97, 115, 101]"
    },
    {
      "name": "listingSeed",
      "type": "bytes",
      "value": "[108, 105, 115, 116, 105, 110, 103]"
    },
    {
      "name": "maxDisputeRounds",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "profileSeed",
      "type": "bytes",
      "value": "[112, 114, 111, 102, 105, 108, 101]"
    },
    {
      "name": "rentHeadroomPct",
      "type": "u16",
      "value": "150"
    },
    {
      "name": "selectionWindowSecs",
      "type": "i64",
      "value": "30"
    },
    {
      "name": "vaultSeed",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    },
    {
      "name": "verdictWindowSecs",
      "type": "i64",
      "value": "60"
    }
  ]
};
